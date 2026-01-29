"""
Redis 락 매니저: 블록 편집 락 관리
"""
import redis
import os
from typing import Tuple, Optional, List


class LockManager:
    """
    Redis 기반 락 매니저

    Redis 키 구조:
    - locks:{roomId}:{blockId} → clientId (String with TTL)
    - clientlocks:{roomId}:{clientId} → Set of blockId
    - online:{roomId} → Hash {clientId: JSON{nickname, color}}
    """

    def __init__(self):
        redis_url = os.environ.get('REDIS_URL', 'redis://localhost:6379/0')
        self.redis = redis.from_url(redis_url, decode_responses=True)

    def acquire_lock(self, room_id: str, block_id: str, client_id: str, ttl_ms: int = 10000) -> Tuple[bool, Optional[str], Optional[str]]:
        """
        락 획득 시도

        Args:
            room_id: 룸 ID
            block_id: 블록 ID
            client_id: 클라이언트 ID
            ttl_ms: Time-To-Live (밀리초)

        Returns:
            (success, current_owner, conflict_block_id): 성공 여부, 현재 락 소유자, 충돌 blockId
        """
        lock_key = f"locks:{room_id}:{block_id}"
        client_locks_key = f"clientlocks:{room_id}:{client_id}"

        # SET NX (존재하지 않을 때만 설정)
        success = self.redis.set(lock_key, client_id, nx=True, px=ttl_ms)

        if success:
            # clientlocks에 blockId 추가
            self.redis.sadd(client_locks_key, block_id)
            return (True, None, None)
        else:
            # 이미 락이 존재함 - 현재 소유자 반환
            current_owner = self.redis.get(lock_key)
            return (False, current_owner, block_id)

    def acquire_lock_group(
        self,
        room_id: str,
        block_ids: List[str],
        client_id: str,
        ttl_ms: int = 10000
    ) -> Tuple[bool, Optional[str], Optional[str]]:
        """
        여러 블록을 그룹으로 락 획득 (원자적)

        Returns:
            (success, current_owner, conflict_block_id)
        """
        # Normalize block ids to strings (avoid Lua arg type errors)
        client_id = str(client_id) if client_id is not None and client_id != "" else None
        block_ids = [str(b) for b in block_ids if b is not None and b != ""]
        if not client_id:
            return (False, None, None)
        if not block_ids:
            return (True, None, None)

        client_locks_key = f"clientlocks:{room_id}:{client_id}"
        lock_keys = [f"locks:{room_id}:{block_id}" for block_id in block_ids]

        lua_script = """
        local client_locks_key = KEYS[1]
        local client_id = ARGV[1]
        local ttl_ms = ARGV[2]

        -- 충돌 검사
        for i = 2, #KEYS do
            local owner = redis.call('GET', KEYS[i])
            if owner and owner ~= client_id then
                local conflict_block_id = ARGV[i + 1]
                return {0, owner, conflict_block_id}
            end
        end

        -- 락 설정
        for i = 2, #KEYS do
            redis.call('SET', KEYS[i], client_id, 'PX', ttl_ms)
            local block_id = ARGV[i + 1]
            redis.call('SADD', client_locks_key, block_id)
        end

        return {1, '', ''}
        """

        keys = [client_locks_key] + lock_keys
        args = [client_id, str(ttl_ms)] + block_ids
        result = self.redis.eval(lua_script, len(keys), *keys, *args)
        if result and int(result[0]) == 1:
            return (True, None, None)
        owner = result[1] if result and len(result) > 1 else None
        conflict_block_id = result[2] if result and len(result) > 2 else None
        return (False, owner or None, conflict_block_id or None)

    def release_lock(self, room_id: str, block_id: str, client_id: str) -> bool:
        """
        특정 락 해제 (소유권 검증 포함)

        Args:
            room_id: 룸 ID
            block_id: 블록 ID
            client_id: 클라이언트 ID

        Returns:
            성공 여부
        """
        lock_key = f"locks:{room_id}:{block_id}"
        client_locks_key = f"clientlocks:{room_id}:{client_id}"

        # Lua script로 원자적 처리 (소유권 확인 + 삭제)
        lua_script = """
        local lock_key = KEYS[1]
        local client_locks_key = KEYS[2]
        local client_id = ARGV[1]
        local block_id = ARGV[2]

        local owner = redis.call('GET', lock_key)
        if owner == client_id then
            redis.call('DEL', lock_key)
            redis.call('SREM', client_locks_key, block_id)
            return 1
        else
            return 0
        end
        """

        result = self.redis.eval(lua_script, 2, lock_key, client_locks_key, client_id, block_id)
        return result == 1

    def release_lock_group(self, room_id: str, block_ids: List[str], client_id: str) -> List[str]:
        """
        여러 락을 그룹으로 해제 (소유권 검증 포함)

        Returns:
            해제된 block_id 목록
        """
        # Normalize block ids to strings (avoid Lua arg type errors)
        client_id = str(client_id) if client_id is not None and client_id != "" else None
        block_ids = [str(b) for b in block_ids if b is not None and b != ""]
        if not client_id:
            return []
        if not block_ids:
            return []

        client_locks_key = f"clientlocks:{room_id}:{client_id}"
        lock_keys = [f"locks:{room_id}:{block_id}" for block_id in block_ids]

        lua_script = """
        local client_locks_key = KEYS[1]
        local client_id = ARGV[1]

        local released = {}
        for i = 2, #KEYS do
            local owner = redis.call('GET', KEYS[i])
            if owner == client_id then
                redis.call('DEL', KEYS[i])
                -- ARGV[1] = client_id, ARGV[2..] = block_ids
                local block_id = ARGV[i]
                redis.call('SREM', client_locks_key, block_id)
                table.insert(released, block_id)
            end
        end
        return released
        """

        keys = [client_locks_key] + lock_keys
        args = [client_id] + block_ids
        try:
            result = self.redis.eval(lua_script, len(keys), *keys, *args)
        except Exception as e:
            # Log keys/args types to diagnose Lua arg errors
            logger = None
            try:
                import logging
                logger = logging.getLogger(__name__)
                logger.error(
                    "[Redis] release_lock_group eval failed: %s | keys=%s args=%s types=%s",
                    e,
                    keys,
                    args,
                    [type(v) for v in (keys + args)],
                )
            except Exception:
                pass
            raise
        return list(result) if result else []

    def release_all_locks(self, room_id: str, client_id: str) -> List[str]:
        """
        클라이언트의 모든 락 해제 (연결 끊김 시)

        Args:
            room_id: 룸 ID
            client_id: 클라이언트 ID

        Returns:
            해제된 block_id 목록
        """
        client_locks_key = f"clientlocks:{room_id}:{client_id}"

        # 클라이언트가 소유한 모든 blockId 조회
        block_ids = list(self.redis.smembers(client_locks_key))

        if not block_ids:
            return []

        # 각 락 해제
        released_blocks = []
        for block_id in block_ids:
            lock_key = f"locks:{room_id}:{block_id}"

            # 소유권 확인 후 삭제
            owner = self.redis.get(lock_key)
            if owner == client_id:
                self.redis.delete(lock_key)
                released_blocks.append(block_id)

        # clientlocks 전체 삭제
        self.redis.delete(client_locks_key)

        return released_blocks

    def get_lock_owner(self, room_id: str, block_id: str) -> Optional[str]:
        """
        현재 락 소유자 확인

        Args:
            room_id: 룸 ID
            block_id: 블록 ID

        Returns:
            소유자 client_id (없으면 None)
        """
        lock_key = f"locks:{room_id}:{block_id}"
        return self.redis.get(lock_key)

    def refresh_ttl(self, room_id: str, block_id: str, client_id: str, ttl_ms: int = 10000) -> bool:
        """
        락 TTL 갱신 (드래그 중)

        Args:
            room_id: 룸 ID
            block_id: 블록 ID
            client_id: 클라이언트 ID
            ttl_ms: 새 TTL (밀리초)

        Returns:
            성공 여부 (소유자가 아니면 False)
        """
        lock_key = f"locks:{room_id}:{block_id}"

        # Lua script로 소유권 확인 후 TTL 갱신
        lua_script = """
        local lock_key = KEYS[1]
        local client_id = ARGV[1]
        local ttl_ms = ARGV[2]

        local owner = redis.call('GET', lock_key)
        if owner == client_id then
            redis.call('PEXPIRE', lock_key, ttl_ms)
            return 1
        else
            return 0
        end
        """

        result = self.redis.eval(lua_script, 1, lock_key, client_id, ttl_ms)
        return result == 1

    def refresh_all_locks(self, room_id: str, client_id: str, ttl_ms: int = 10000) -> int:
        """
        클라이언트가 보유한 모든 락 TTL 갱신

        Returns:
            갱신된 락 개수
        """
        client_locks_key = f"clientlocks:{room_id}:{client_id}"
        block_ids = list(self.redis.smembers(client_locks_key))
        if not block_ids:
            return 0

        refreshed = 0
        for block_id in block_ids:
            if self.refresh_ttl(room_id, block_id, client_id, ttl_ms):
                refreshed += 1
        return refreshed

    def get_all_locks(self, room_id: str) -> dict:
        """
        룸의 모든 락 상태 조회 (INIT_STATE용)

        Args:
            room_id: 룸 ID

        Returns:
            {blockId: clientId} 딕셔너리
        """
        pattern = f"locks:{room_id}:*"
        locks = {}

        for key in self.redis.scan_iter(match=pattern):
            block_id = key.split(':')[-1]
            owner = self.redis.get(key)
            if owner:
                locks[block_id] = owner

        return locks
