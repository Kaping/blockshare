# 백엔드 기술 상세화 (현재 코드 기반)

이 문서는 현재 백엔드 코드 기준으로 동작과 저장 구조를 상세히 정리한 문서입니다.

## 관련 코드

- `backend/workspace/consumers.py`
- `backend/workspace/redis_client.py`
- `backend/workspace/models.py`
- `backend/workspace/views.py`
- `backend/workspace/serializers.py`

## 연결/방 관리 (WebSocket)

### 요구사항(정의)

- URL: `ws://domain/ws/workspace/{roomId}/?nickname={닉네임}`
- `nickname` 필수 입력
- 색상: 4개 고정 팔레트에서 랜덤 할당
- 세션 당 색상 배열은 최대 인원 수와 동일 (4개)
- `Room.max_users == 4`
- `Room.status == FULL | CLOSED` → 연결 종료 (close code `4003`)
- `Room.status == WAITING`인 경우만 그룹 조인
- `roomId` 형식: 영대문자 4개 + 숫자 2개
- `roomId`는 사용자가 임의 생성하지 않고 **서버/관리자 페이로드로 발급**

### 1) 연결 흐름

- URL: `ws://localhost:8000/ws/workspace/{roomId}/?nickname=...`
- 처리 순서:
  - `roomId` 파싱
  - `nickname` 쿼리 파라미터 파싱 (미지정 시 `User####`)
  - `clientId` UUID 생성
  - 랜덤 색상 할당
  - `Room` 조회/생성
  - 현재 온라인 인원 확인 후 인원 제한 검사
  - 연결 수락 → 그룹 조인
  - Redis에 사용자 추가
  - `INIT_STATE` 전송
  - `USER_JOINED` broadcast

### 2) 인원 제한

- `Room.max_users` 기준으로만 제한
- 기본값: 10 (`Room` 생성 시)
- 인원 초과 시 연결 종료 (close code `4003`)
- 방 상태 ENUM(FULL/WAITING/CLOSED)은 현재 서버에 없음
  - `Room.status` 필드/로직 미구현

### 3) 방 ID 유효성/존재 검증

- `Room.objects.get_or_create()`로 자동 생성됨
- 결과적으로 **존재하지 않는 방 번호 거부 로직은 없음**
  - `roomId` 형식 검증 및 발급(서버 페이로드) 미구현

### 4) Client ID

- 서버가 연결 시마다 새로운 UUID 생성
- 서버에서 브라우저 단위 유지/검증은 하지 않음
- 중복 접속 차단, 동일 Client ID 1방 제한은 **미구현**

### 5) 사용자 상태 정리

- Redis `online:{roomId}`의 `lastSeen`을 기반으로 stale 사용자 정리
- TTL 기준: 30초 (`USER_TTL_SECONDS`)
- `HEARTBEAT` 메시지 수신 시 `lastSeen` 갱신

## 메시지 타입/라우팅

- `LOCK_ACQUIRE` → 락 획득 처리
- `COMMIT` → 블록 변경 커밋 처리
- `HEARTBEAT` → 사용자 lastSeen 갱신

## 락 처리 (Redis)

### 1) 단일 락

- 키: `locks:{roomId}:{blockId}` → `clientId` (TTL)
- 획득: `SET NX PX`
- 실패 시 `LOCK_DENIED` 응답 (owner, ttlMs 포함)

### 2) 그룹 락

- 여러 블록을 Lua 스크립트로 원자적으로 잠금
- 충돌 발생 시 소유자/충돌 블록 ID 반환

### 3) 락 해제

- 단일/그룹/전체 해제 지원
- 소유권 검증 후 해제
- `disconnect` 시 보유 락 전부 해제 후 `LOCK_UPDATE` broadcast

## COMMIT 처리

- 락 소유권 검증 후 처리
- 워크스페이스 이벤트를 `COMMIT_APPLY`로 broadcast
- 필요 시 `LOCK_UPDATE(owner=null)` broadcast
- `workspaceXml`이 있으면 Redis에 스냅샷 저장
- 미션 성공 여부 판정 로직은 없음

## 스테이지/정답 판정 (요구사항)

- 방 단위로 현재 스테이지를 관리
- 스테이지별 정답 정의:
  - 존재해야 하는 블록 타입
  - 블록별 허용 개수
  - 블록 배치/연결 구조 (XML/AST/규칙 기반)
- `COMMIT` 이벤트마다:
  - 현재 워크스페이스와 정답을 비교
  - 성공 여부 판정(퍼즐 성공 상태)
  - 필요 시 성공 상태를 Redis/DB에 반영

## INIT_STATE 전송

- 연결 직후 아래 정보 전송:
  - `clientId`
  - `users`: 온라인 사용자 목록 (본인 제외)
  - `locks`: 현재 락 상태
  - `workspaceXml` (옵션)

## 저장 구조

### PostgreSQL

- `rooms` 테이블:
  - `room_id` (PK)
  - `title`
  - `max_users`
  - `created_at`
- 스테이지/정답 비교를 위한 테이블 정의 필요 (미구현)
  - `stages`
    - `stage_id` (PK)
    - `title`
    - `order_index`
    - `is_active`
  - `stage_answers` (정답 정의)
    - `id` (PK)
    - `stage_id` (FK)
    - `answer_xml` 또는 `answer_json` (블록 구조/연결 정답)
    - `rule_version` (정답 규칙 버전 관리)
  - `stage_block_rules` (블록 타입/개수 규칙)
    - `id` (PK)
    - `stage_id` (FK)
    - `block_type`
    - `min_count`
    - `max_count`
  - `room_stage_state` (방별 진행 상태)
    - `room_id` (FK)
    - `stage_id` (FK)
    - `success` (BOOL)
    - `last_checked_at`
    - `updated_at`
    - `PRIMARY KEY(room_id, stage_id)`
  - `room_stage_workspace` (선택: 영속 스냅샷)
    - `room_id` (FK)
    - `stage_id` (FK)
    - `workspace_xml`
    - `updated_at`
    - `PRIMARY KEY(room_id, stage_id)`
  - 브라우저 단위 접속 제한을 위한 사용자/세션 테이블 필요 (향후)
    - `users`
      - `user_id` (PK)
      - `client_id` (브라우저 단위 식별자, unique)
      - `created_at`
      - `last_seen_at`
    - `room_user_sessions`
      - `room_id` (FK)
      - `user_id` (FK)
      - `connected_at`
      - `disconnected_at`
      - `PRIMARY KEY(room_id, user_id)`

### Redis

- `locks:{roomId}:{blockId}` → `clientId`
- `clientlocks:{roomId}:{clientId}` → Set of `blockId`
- `online:{roomId}` → Hash `{clientId: JSON{nickname,color,lastSeen}}`
- `blocks:{roomId}` → `workspaceXml` 스냅샷
- 스테이지 상태 캐시 필요 (미구현)
  - `stage:{roomId}` → `{stage, success, lastCheckedAt}`
  - `stage:answer:{stageId}` → `{answerXml/answerJson, ruleVersion}`
  - `stage:rules:{stageId}` → `{blockType: {min,max}}`

## HTTP API

### GET /workspace/room/{room_id}

- Room 존재 시 반환
- Room 미존재 시 자동 생성
- 응답: `room_id`, `title`, `max_users`, `current_users`, `created`

## 현재 미구현 항목 (요구사항 대비)

- 방 상태 관리(ENUM FULL/WAITING/CLOSED) 및 수동 변경
- 방 입장 사유 반환 (FULL/INVALID ROOM NUMBER 등)
- Client ID 브라우저 단위 유지 및 중복 접속 제한
- 동일 Client ID의 중복 WebSocket 연결 차단
- 방/스테이지 진행 상태 저장 및 복구
- 스테이지 조건 기반 이동 승인
- 미션 완료 조건 판정 및 편집 제한
- `COMMIT`마다 정답 비교 및 퍼즐 성공 상태 저장
- 이모지 커뮤니케이션/중복 제한
- 아두이노 업로드/Local Agent 연동
- 교사/학습자 권한, 강제 퇴장, 관리자 기능
