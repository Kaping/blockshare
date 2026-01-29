"""
WebSocket Consumer: 실시간 협업 편집
"""
import logging
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async
import json
import uuid
import random
import time
import redis.asyncio as aioredis
import os
from urllib.parse import unquote

from .serializers import serialize_message, deserialize_message, MessageType
from .redis_client import LockManager
from .models import Room

logger = logging.getLogger(__name__)
USER_TTL_SECONDS = 30

class WorkspaceConsumer(AsyncWebsocketConsumer):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.room_id = None
        self.client_id = None
        self.nickname = None
        self.color = None
        self.room_group_name = None
        self.lock_manager = LockManager()

        # Async Redis 연결
        redis_url = os.environ.get('REDIS_URL', 'redis://localhost:6379/0')
        self.redis = aioredis.from_url(redis_url, decode_responses=True)

    async def connect(self):
        """
        WebSocket 연결 시 호출

        1. room_id 추출
        2. nickname 추출 (쿼리 파라미터)
        3. client_id 생성
        4. 색상 할당
        5. Room 존재 확인
        6. 인원 체크
        7. Redis에 사용자 추가
        8. INIT_STATE 전송
        9. USER_JOINED broadcast
        """
        try:
            self.room_id = self.scope['url_route']['kwargs']['room_id']
            logger.info("[WS] Connecting to room: %s", self.room_id)

            # 쿼리 파라미터에서 nickname 추출
            query_string = self.scope.get('query_string', b'').decode('utf-8')
            params = dict(param.split('=') for param in query_string.split('&') if '=' in param)
            nickname_encoded = params.get('nickname', f'User{random.randint(1000, 9999)}')
            self.nickname = unquote(nickname_encoded)  # URL 디코딩
            logger.info("[WS] Nickname: %s", self.nickname)

            # 클라이언트 ID 및 색상 생성
            self.client_id = str(uuid.uuid4())
            self.color = self._generate_random_color()
            logger.info("[WS] Client ID: %s", self.client_id)

            # Room 그룹 이름
            self.room_group_name = f'workspace_{self.room_id}'

            # Room 존재 확인
            room = await self._get_room()
            logger.info("[WS] Room found: %s", room)
            if not room:
                logger.warning("[WS] Room not found, closing connection")
                await self.close(code=4004)
                return

            # 인원 체크
            current_users = await self._get_current_users_count()
            logger.info("[WS] Current users: %s/%s", current_users, room.max_users)
            if current_users >= room.max_users:
                logger.warning("[WS] Room full, closing connection")
                await self.close(code=4003)  # Room full
                return

            # 연결 수락
            logger.info("[WS] Accepting connection")
            await self.accept()

            # 그룹에 조인
            logger.info("[WS] Joining group")
            await self.channel_layer.group_add(
                self.room_group_name,
                self.channel_name
            )

            # Redis에 사용자 추가
            logger.info("[WS] Adding user to Redis")
            await self._add_user_to_redis()

            # INIT_STATE 전송
            logger.info("[WS] Sending INIT_STATE")
            await self._send_init_state()

            # USER_JOINED broadcast (다른 사용자들에게)
            logger.info("[WS] Broadcasting USER_JOINED")
            await self.channel_layer.group_send(
                self.room_group_name,
                {
                    'type': 'user_joined',
                    'client_id': self.client_id,
                    'nickname': self.nickname,
                    'color': self.color,
                }
            )
            logger.info("[WS] Connection complete!")

        except Exception as e:
            logger.exception("[WS ERROR] Connection failed: %s", e)
            await self.close()

    async def disconnect(self, close_code):
        """
        WebSocket 연결 종료 시 호출

        1. 모든 락 해제
        2. LOCK_UPDATE broadcast
        3. Redis에서 사용자 제거
        4. USER_LEFT broadcast
        """
        if not self.client_id or not self.room_id:
            return

        # 모든 락 해제
        released_blocks = self.lock_manager.release_all_locks(self.room_id, self.client_id)

        # 각 락에 대해 LOCK_UPDATE broadcast
        for block_id in released_blocks:
            await self.channel_layer.group_send(
                self.room_group_name,
                {
                    'type': 'lock_update',
                    'block_id': block_id,
                    'owner': None,
                }
            )

        # Redis에서 사용자 제거
        await self._remove_user_from_redis()

        # USER_LEFT broadcast
        await self.channel_layer.group_send(
            self.room_group_name,
            {
                'type': 'user_left',
                'client_id': self.client_id,
            }
        )

        # 그룹에서 제거
        await self.channel_layer.group_discard(
            self.room_group_name,
            self.channel_name
        )

    async def receive(self, text_data):
        """
        메시지 수신 시 호출

        메시지 라우팅:
        - LOCK_ACQUIRE → handle_lock_acquire()
        - COMMIT → handle_commit()
        """
        message = deserialize_message(text_data)
        if not message:
            return

        msg_type = message['t']
        payload = message['payload']

        if msg_type == MessageType.LOCK_ACQUIRE:
            await self.handle_lock_acquire(payload)
        elif msg_type == MessageType.COMMIT:
            await self.handle_commit(payload)
        elif msg_type == MessageType.HEARTBEAT:
            await self._touch_user_in_redis()

    async def handle_lock_acquire(self, payload):
        """
        락 획득 요청 처리

        1. acquire_lock() 호출
        2. 성공 → LOCK_UPDATE broadcast
        3. 실패 → LOCK_DENIED 응답
        """
        block_id = payload.get('blockId')
        if not block_id:
            return

        success, current_owner = self.lock_manager.acquire_lock(
            self.room_id,
            block_id,
            self.client_id
        )

        if success:
            # LOCK_UPDATE broadcast
            await self.channel_layer.group_send(
                self.room_group_name,
                {
                    'type': 'lock_update',
                    'block_id': block_id,
                    'owner': self.client_id,
                }
            )
        else:
            # LOCK_DENIED 응답 (이 클라이언트에게만)
            ttl = self.lock_manager.redis.pttl(f"locks:{self.room_id}:{block_id}")
            await self.send(text_data=serialize_message(MessageType.LOCK_DENIED, {
                'blockId': block_id,
                'owner': current_owner,
                'ttlMs': max(ttl, 0) if ttl > 0 else 0,
            }))

    async def handle_commit(self, payload):
        """
        커밋 처리 (블록 이동 완료)

        1. 락 소유권 검증
        2. 락 해제
        3. COMMIT_APPLY broadcast
        4. LOCK_UPDATE (owner=null) broadcast
        """
        block_id = payload.get('blockId')
        events = payload.get('events', [])
        workspace_xml = payload.get('workspaceXml')
        release_lock = payload.get('releaseLock', True)

        if not block_id:
            return

        # 락 소유권 검증 (락이 있으면 소유자만 허용)
        owner = self.lock_manager.get_lock_owner(self.room_id, block_id)
        if owner and owner != self.client_id:
            return  # 소유자가 아니면 무시

        # 락 해제 (요청된 경우만)
        if release_lock:
            self.lock_manager.release_lock(self.room_id, block_id, self.client_id)

        # 워크스페이스 스냅샷 저장 (옵션)
        if workspace_xml:
            await self._set_workspace_snapshot(workspace_xml)

        # COMMIT_APPLY broadcast
        await self.channel_layer.group_send(
            self.room_group_name,
            {
                'type': 'commit_apply',
                'block_id': block_id,
                'events': events,
                'by': self.client_id,
                'workspace_xml': workspace_xml,
            }
        )

        # LOCK_UPDATE (owner=null) broadcast
        if release_lock:
            await self.channel_layer.group_send(
                self.room_group_name,
                {
                    'type': 'lock_update',
                    'block_id': block_id,
                    'owner': None,
                }
            )

    # === Group message handlers ===

    async def lock_update(self, event):
        """LOCK_UPDATE 메시지 전송"""
        await self.send(text_data=serialize_message(MessageType.LOCK_UPDATE, {
            'blockId': event['block_id'],
            'owner': event['owner'],
        }))

    async def commit_apply(self, event):
        """COMMIT_APPLY 메시지 전송"""
        payload = {
            'blockId': event['block_id'],
            'events': event['events'],
            'by': event['by'],
        }
        if event.get('workspace_xml'):
            payload['workspaceXml'] = event['workspace_xml']
        await self.send(text_data=serialize_message(MessageType.COMMIT_APPLY, payload))

    async def user_joined(self, event):
        """USER_JOINED 메시지 전송 (자신 제외)"""
        if event['client_id'] != self.client_id:
            await self.send(text_data=serialize_message(MessageType.USER_JOINED, {
                'clientId': event['client_id'],
                'nickname': event['nickname'],
                'color': event['color'],
            }))

    async def user_left(self, event):
        """USER_LEFT 메시지 전송"""
        if event['client_id'] != self.client_id:
            await self.send(text_data=serialize_message(MessageType.USER_LEFT, {
                'clientId': event['client_id'],
            }))

    # === Helper methods ===

    @database_sync_to_async
    def _get_room(self):
        """Room 조회 또는 생성"""
        room, created = Room.objects.get_or_create(
            room_id=self.room_id,
            defaults={
                'title': f'Room {self.room_id}',
                'max_users': 10
            }
        )
        return room

    async def _get_current_users_count(self):
        """현재 온라인 사용자 수 조회"""
        await self._prune_stale_users()
        online_key = f"online:{self.room_id}"
        return await self.redis.hlen(online_key)

    async def _add_user_to_redis(self):
        """Redis에 사용자 추가"""
        online_key = f"online:{self.room_id}"
        user_data = json.dumps({
            'nickname': self.nickname,
            'color': self.color,
            'lastSeen': time.time(),
        })
        await self.redis.hset(online_key, self.client_id, user_data)

    async def _touch_user_in_redis(self):
        """Redis 사용자 lastSeen 갱신"""
        if not self.client_id:
            return
        online_key = f"online:{self.room_id}"
        user_data = json.dumps({
            'nickname': self.nickname,
            'color': self.color,
            'lastSeen': time.time(),
        })
        await self.redis.hset(online_key, self.client_id, user_data)

    async def _prune_stale_users(self):
        """오래된 사용자 정리"""
        online_key = f"online:{self.room_id}"
        users_data = await self.redis.hgetall(online_key)
        if not users_data:
            return

        now = time.time()
        stale_ids = []
        for client_id, user_json in users_data.items():
            try:
                user = json.loads(user_json)
                last_seen = user.get('lastSeen', 0)
                if now - last_seen > USER_TTL_SECONDS:
                    stale_ids.append(client_id)
            except Exception:
                stale_ids.append(client_id)

        if stale_ids:
            await self.redis.hdel(online_key, *stale_ids)

    async def _remove_user_from_redis(self):
        """Redis에서 사용자 제거"""
        online_key = f"online:{self.room_id}"
        await self.redis.hdel(online_key, self.client_id)

    async def _send_init_state(self):
        """INIT_STATE 전송"""
        try:
            await self._prune_stale_users()

            # 온라인 사용자 목록
            online_key = f"online:{self.room_id}"
            users_data = await self.redis.hgetall(online_key)
            users = []
            for client_id, user_json in users_data.items():
                if client_id != self.client_id:  # 자신 제외
                    user = json.loads(user_json)
                    users.append({
                        'clientId': client_id,
                        'nickname': user['nickname'],
                        'color': user['color'],
                    })

            # 현재 락 상태 (async로 조회)
            locks = await self._get_all_locks_async()

            # 워크스페이스 스냅샷
            workspace_xml = await self._get_workspace_snapshot()

            # INIT_STATE 전송
            logger.info("[WS] Sending INIT_STATE with %d users and %d locks", len(users), len(locks))
            payload = {
                'clientId': self.client_id,  # 자신의 clientId 추가!
                'users': users,
                'locks': locks,
            }
            if workspace_xml:
                payload['workspaceXml'] = workspace_xml
            await self.send(text_data=serialize_message(MessageType.INIT_STATE, payload))
            logger.info("[WS] INIT_STATE sent successfully")
        except Exception as e:
            logger.exception("[WS ERROR] Failed to send INIT_STATE: %s", e)
            raise

    async def _get_workspace_snapshot(self):
        """워크스페이스 스냅샷 조회"""
        key = f"blocks:{self.room_id}"
        return await self.redis.get(key)

    async def _set_workspace_snapshot(self, workspace_xml: str):
        """워크스페이스 스냅샷 저장"""
        key = f"blocks:{self.room_id}"
        await self.redis.set(key, workspace_xml)

    async def _get_all_locks_async(self):
        """룸의 모든 락 상태 조회 (async 버전)"""
        pattern = f"locks:{self.room_id}:*"
        locks = {}

        try:
            # async Redis scan_iter 사용
            async for key in self.redis.scan_iter(match=pattern, count=100):
                block_id = key.split(':')[-1]
                owner = await self.redis.get(key)
                if owner:
                    locks[block_id] = owner
        except Exception as e:
            logger.exception("[WS ERROR] Failed to get locks: %s", e)
            # 에러가 나도 빈 dict 반환 (연결은 유지)
            locks = {}

        return locks

    def _generate_random_color(self):
        """랜덤 색상 생성 (사용자 구분용)"""
        colors = [
            '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A',
            '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E2',
            '#F8B739', '#52B788', '#E63946', '#457B9D',
        ]
        return random.choice(colors)
