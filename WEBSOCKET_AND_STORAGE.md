# WebSocket 통신/저장 베이스

이 문서는 현재 코드 기준으로 소켓 통신 로직과 저장 구조를 정리한 베이스입니다.

## 관련 파일

- 백엔드: `backend/workspace/consumers.py`, `backend/workspace/redis_client.py`, `backend/workspace/models.py`
- 프론트엔드: `frontend/src/services/websocket.ts`, `frontend/src/services/lockManager.ts`, `frontend/src/types/messages.ts`

## 연결 흐름 (connect)

1. 클라이언트가 `ws://localhost:8000/ws/workspace/{roomId}/?nickname=...`로 연결
2. 서버가 `room_id`, `nickname`을 파싱하고 `client_id`, `color` 생성
3. `Room` 존재 확인 (없으면 생성) 및 인원 제한 확인
4. 연결 수락 후 그룹에 조인
5. Redis에 온라인 사용자 추가
6. `INIT_STATE` 전송
7. `USER_JOINED` broadcast

## 메시지 처리 흐름

### LOCK_ACQUIRE

- Client -> Server: `{ t: 'LOCK_ACQUIRE', payload: { blockId } }`
- Server:
  - `LockManager.acquire_lock()`로 Redis 락 획득 시도 (SET NX + TTL)
  - 성공: `LOCK_UPDATE` broadcast
  - 실패: `LOCK_DENIED` 응답 (ttlMs 포함)

### COMMIT

- Client -> Server: `{ t: 'COMMIT', payload: { blockId, events, workspaceXml? } }`
- Server:
  - 락 소유자 검증 (락이 있으면 소유자만 허용)
  - 락 해제
  - `workspaceXml`이 있으면 Redis 스냅샷 저장
  - `COMMIT_APPLY` broadcast
  - `LOCK_UPDATE`(owner=null) broadcast

### HEARTBEAT

- Client -> Server: `{ t: 'HEARTBEAT', payload: {} }`
- Server: Redis의 `online:{roomId}`에 lastSeen 갱신

## INIT_STATE

연결 직후 서버가 아래 정보를 전송합니다.

- `clientId`: 현재 클라이언트 ID
- `users`: 온라인 사용자 목록
- `locks`: 현재 락 상태 (blockId -> owner)
- `workspaceXml` (옵션): Redis 스냅샷

## disconnect 처리

1. 모든 락 해제 및 `LOCK_UPDATE` broadcast
2. Redis에서 사용자 제거
3. `USER_LEFT` broadcast
4. 그룹에서 제거

## 저장 구조

### PostgreSQL (DB)

- `rooms` 테이블에 룸 메타데이터 저장
  - `room_id`, `title`, `max_users`, `created_at`
- 연결 시 `Room.objects.get_or_create()`로 보장

### Redis

- `locks:{roomId}:{blockId}` -> `clientId` (TTL)
- `clientlocks:{roomId}:{clientId}` -> Set of `blockId`
- `online:{roomId}` -> Hash `{clientId: {nickname, color, lastSeen}}`
- `blocks:{roomId}` -> `workspaceXml` (워크스페이스 스냅샷)

## 현재 DB 저장 이슈 정리

- 블록 상태(워크스페이스 XML)는 현재 Redis에만 저장됩니다.
- DB 영구 저장 로직은 아직 없습니다.
- DB 저장이 필요하면 별도 모델(예: `WorkspaceSnapshot`) 추가 및 `COMMIT` 처리 시 저장 로직이 필요합니다.

