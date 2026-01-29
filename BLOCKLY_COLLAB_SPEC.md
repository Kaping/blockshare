# Blockly 협업 기능 명세 (현재 코드 기반)

이 문서는 현재 구현된 코드 기준으로 Blockly 협업 동작을 상세히 정리한 명세입니다.

## 관련 코드

- `frontend/src/components/BlocklyEditor.tsx`
- `frontend/src/services/lockManager.ts`
- `backend/workspace/consumers.py`
- `backend/workspace/redis_client.py`

## 기본 전제

- 동일한 방(Room)에 참여한 학습자는 하나의 Blockly 워크스페이스를 공유한다.
- 블록은 특정 시점에 한 명의 사용자만 제어할 수 있다 (락 기반).
- 락은 블록 단위로 걸리며, UI에서 해당 블록이 포함된 연결된 그룹 전체에 적용된다.

## 이벤트/락 처리 상세 (프론트)

### 1) 블록 선택(클릭)

- 이벤트: `Blockly.Events.SELECTED` 또는 `selected`
- 동작:
  - `newId`가 존재하고 내 락이 없으면 `LOCK_ACQUIRE` 요청
  - `LOCK_DENIED` 시 선택은 유지되더라도 서버 락이 없으므로 실제 편집은 제한됨
  - 선택이 해제되며 기존 블록 `oldId`가 바뀌는 경우,
    - `oldId`에 대해 `releaseLock(oldId, [], workspaceXml, true)` 호출
    - 이후 새 블록에 대해 필요 시 `LOCK_ACQUIRE` 요청
- 근거 코드: `handleBlockSelected`

### 2) 워크스페이스 클릭(선택 해제)

- 이벤트: `Blockly.Events.CLICK` 또는 `click`
- 동작:
  - 선택된 블록이 없고 드래그 중이 아니면,
  - 내가 가진 모든 락을 `releaseLock`으로 해제
- 근거 코드: `handleWorkspaceClick`

### 3) 블록 드래그 시작/종료

- 이벤트: `BLOCK_DRAG` 또는 `drag` (UI 이벤트)
- 드래그 시작:
  - 해당 블록이 내 락이 아니면 드래그를 차단 (`dragDeniedRef`)
  - 내 락인 경우 드래그 시작 상태로 기록
- 드래그 종료:
  - `finalizeDrag()` 호출 → 모아둔 이동 이벤트를 `commitWithoutLock`으로 전송
- 근거 코드: `handleBlockDrag`, `finalizeDrag`

### 4) 블록 이동 (BLOCK_MOVE)

- 이벤트: `Blockly.Events.BLOCK_MOVE`
- 동작:
  - 드래그 중이면 이동 이벤트를 누적하고 종료를 디바운스
  - 드래그 중이 아니라면 즉시 `commitWithoutLock` 전송
- 근거 코드: `handleBlockMove`

### 5) 블록 생성/삭제/변경

- 이벤트: `BLOCK_CREATE`, `BLOCK_DELETE`, `BLOCK_CHANGE` 등
- 동작:
  - 해당 블록이 타 사용자 락이면 `workspace.undo(false)`로 되돌림
  - 그렇지 않으면 `commitWithoutLock` 전송
- 근거 코드: `handleBlocklyEvent`

## 그룹 블록 락 동작

- Blockly의 연결된 블록 그룹을 `getRootBlock().getDescendants(true)`로 탐색
- 락이 걸리면 그룹 전체에 다음 적용:
  - 시각적 하이라이트 (`my-lock` 또는 `other-lock`)
  - 편집/이동/삭제/선택 비활성화 (`setEditable`, `setMovable`, `setDeletable`, `setSelectable`)
- 락 해제 시 그룹 전체를 원복
- 근거 코드: `applyLockToSubtree`, `clearLockFromSubtree`

## 락 해제 조건 (현재 구현 기준)

1. 드래그 종료 시 (정상)
   - `finalizeDrag()`에서 `commitWithoutLock` 전송
2. 선택 해제/다른 블록 선택 시
   - `handleBlockSelected`에서 `releaseLock(..., force=true)`
3. 워크스페이스 클릭으로 선택 해제 시
   - `handleWorkspaceClick`에서 내 모든 락 해제
4. WebSocket 세션 종료 시 (비정상)
   - 서버가 보유한 락을 전부 해제하고 `LOCK_UPDATE` broadcast

## 서버 처리 흐름 (락/커밋)

### LOCK_ACQUIRE

- Redis `locks:{roomId}:{blockId}`에 `SET NX` + TTL
- 성공 시 `LOCK_UPDATE` broadcast
- 실패 시 `LOCK_DENIED` 응답(남은 TTL 포함)

### COMMIT

- 락 소유권 검증 후 통과 시 적용
- 락 해제 후 `COMMIT_APPLY` broadcast
- `LOCK_UPDATE(owner=null)` broadcast
- `workspaceXml` 있으면 Redis 스냅샷 갱신

## 동기화 규칙

- 모든 변경사항은 WebSocket으로 `COMMIT_APPLY` 이벤트로 전파
- 클라이언트는 수신한 이벤트를 `Blockly.Events.fromJson().run(true)`로 적용
- 스냅샷은 `INIT_STATE` 또는 커밋 시 동기화됨

## “이전 위치/최종 위치” 규칙에 대한 현재 상태

요청 조건:
- 세션 종료로 해제 시 이전 위치 사용
- 락 해제 순간 최종 위치 확정
- 최종 위치가 범위 밖이면 이전 위치로 이동

현재 구현:
- **이전 위치 복원/범위 검증 로직은 구현되지 않음**
- 드래그 종료 시 기록된 `BLOCK_MOVE` 이벤트를 전송하고, 서버는 이를 그대로 broadcast
- 필요 시 별도 로직 추가 필요 (클라이언트 또는 서버에서 위치 검증/복원)

## 블록 제공 제한(스테이지별 개수)

요구사항 예:
- `if` 2개, `led` 1개 등

현재 구현:
- **개수 제한 로직은 구현되어 있지 않음**
- Toolbox에서 블록 제공만 정의됨 (`getToolbox`)
- 제한이 필요하면 Blockly의 제한 로직(블록 생성 후 카운트 체크) 추가 필요

## 블록 제거

- UI에서 삭제 가능 (`trashcan: true`, `setDeletable(true)`)
- 삭제 이벤트는 `BLOCK_DELETE`로 처리되어 실시간 동기화됨

## 참고: 사용자 표시

- 락된 블록에는 사용자 닉네임 배지가 표시됨
- 닉네임은 `INIT_STATE` 또는 `USER_JOINED`로 받은 맵을 사용

