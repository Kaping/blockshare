# BlockShare - 실시간 협업 Blockly 편집기

Blockly 기반 실시간 협업 편집 시스템. 여러 사용자가 동시에 블록을 편집하며, 락(lock) 메커니즘으로 충돌을 방지합니다.

## 기술 스택

- **백엔드**: Django + Django Channels (WebSocket) + Redis + PostgreSQL
- **프론트엔드**: React + TypeScript + Blockly + Vite
- **인프라**: Docker Compose

## 주요 기능

✅ **락 메커니즘**
- 블록 드래그 시 자동 락 획득
- TTL 기반 자동 락 해제 (10초)
- 락 충돌 감지 및 드래그 취소

✅ **실시간 동기화**
- WebSocket 기반 실시간 통신
- 블록 이동 즉시 반영
- 온라인 사용자 목록 실시간 업데이트

✅ **다중 사용자 UI**
- 사용자별 색상 구분
- 편집 중인 블록 시각적 표시
- 온라인 사용자 목록

✅ **연결 안정성**
- 자동 재연결 (exponential backoff)
- 연결 끊김 시 락 자동 해제
- 재연결 시 상태 복구

## 빠른 시작

### 1. Docker Compose 사용 (권장)

```bash
# 모든 서비스 시작
docker-compose up --build

# 데이터베이스 마이그레이션
docker-compose exec backend python manage.py migrate

# 슈퍼유저 생성 (Admin 접속용, 선택사항)
docker-compose exec backend python manage.py createsuperuser
```

서비스 접속:
- **프론트엔드**: http://localhost:5173
- **백엔드 API**: http://localhost:8000/api/
- **Admin**: http://localhost:8000/admin/

### 2. 로컬 설치

#### 필수 요구사항
- Python 3.11+
- Node.js 20+
- PostgreSQL 15+
- Redis 7+

#### 백엔드 설정

```bash
cd backend

# 가상환경 생성 및 활성화
python -m venv venv
source venv/bin/activate  # Windows: venv\\Scripts\\activate

# 의존성 설치
pip install -r requirements.txt

# 환경변수 설정
export DATABASE_URL=postgresql://blockshare:blockshare@localhost:5432/blockshare
export REDIS_URL=redis://localhost:6379/0

# 마이그레이션
python manage.py migrate

# 서버 실행
daphne -b 0.0.0.0 -p 8000 blockshare.asgi:application
```

#### 프론트엔드 설정

```bash
cd frontend

# 의존성 설치
npm install

# 개발 서버 실행
npm run dev
```

## 사용 방법

1. **Room 입장**
   - 브라우저에서 `/room/test123` 접속
   - 닉네임 입력 후 입장

2. **블록 편집**
   - 툴박스에서 블록 선택
   - 블록 드래그 시 자동으로 락 획득
   - 다른 사용자가 편집 중인 블록은 빨간색으로 표시

3. **협업 작업**
   - 여러 탭/브라우저에서 동일한 Room ID로 접속
   - 각 사용자가 서로 다른 블록을 동시에 편집 가능
   - 같은 블록을 동시에 편집하려 하면 "다른 사용자가 편집 중" 알림

## 아키텍처

### 문서

- WebSocket 통신/저장 베이스: `WEBSOCKET_AND_STORAGE.md`
- Blockly 협업 기능 명세: `BLOCKLY_COLLAB_SPEC.md`

### 데이터 흐름

```
Client A                    Server                     Client B
   |                          |                           |
   |--- LOCK_ACQUIRE -------->|                           |
   |                          |--- LOCK_UPDATE --------->|
   |<--- LOCK_UPDATE ---------|                           |
   |                          |                           |
   |--- COMMIT --------------->|                           |
   |                          |--- COMMIT_APPLY --------->|
   |<--- LOCK_UPDATE ---------|--- LOCK_UPDATE --------->|
   |    (owner=null)          |    (owner=null)           |
```

### Redis 키 구조

- `locks:{roomId}:{blockId}` → `clientId` (String with TTL)
- `clientlocks:{roomId}:{clientId}` → Set of `blockId`
- `online:{roomId}` → Hash {clientId: JSON{nickname, color}}

### 메시지 스펙

#### Client → Server
- `LOCK_ACQUIRE`: 락 획득 요청
- `COMMIT`: 변경사항 커밋 (블록 이동 완료)

#### Server → Client
- `LOCK_DENIED`: 락 획득 실패
- `LOCK_UPDATE`: 락 상태 변경 (broadcast)
- `COMMIT_APPLY`: 커밋 적용 (broadcast)
- `USER_JOINED`: 사용자 입장 (broadcast)
- `USER_LEFT`: 사용자 퇴장 (broadcast)
- `INIT_STATE`: 연결 직후 초기 상태

## 개발

### 프로젝트 구조

```
blockshare/
├── backend/                 # Django 백엔드
│   ├── blockshare/         # 프로젝트 설정
│   │   ├── settings.py
│   │   ├── asgi.py
│   │   └── routing.py
│   └── workspace/          # 메인 앱
│       ├── consumers.py    # WebSocket Consumer
│       ├── models.py       # Room 모델
│       ├── redis_client.py # Redis 락 매니저
│       ├── views.py        # HTTP API
│       └── urls.py
│
└── frontend/                # React 프론트엔드
    └── src/
        ├── components/
        │   ├── JoinRoom.tsx        # 입장 화면
        │   ├── Workspace.tsx       # 메인 워크스페이스
        │   ├── BlocklyEditor.tsx   # Blockly 통합
        │   └── OnlineUsers.tsx     # 온라인 사용자 목록
        ├── services/
        │   ├── websocket.ts        # WebSocket 클라이언트
        │   └── lockManager.ts      # 클라이언트 락 관리
        └── types/
            └── messages.ts         # 메시지 타입 정의
```

### 테스트

```bash
# 백엔드 테스트
cd backend
python manage.py test

# 프론트엔드 테스트 (예정)
cd frontend
npm test
```

## 트러블슈팅

### 포트 충돌
- PostgreSQL: 5432
- Redis: 6379
- Django: 8000
- React: 5173

해당 포트가 이미 사용 중이면 `docker-compose.yml`에서 포트를 변경하세요.

### WebSocket 연결 실패
1. 백엔드가 실행 중인지 확인: `http://localhost:8000/api/room/test/`
2. Redis가 실행 중인지 확인: `docker ps | grep redis`
3. CORS 설정 확인: `settings.py`의 `CORS_ALLOW_ALL_ORIGINS`

### 블록이 동기화되지 않음
1. 브라우저 콘솔에서 WebSocket 연결 상태 확인
2. 네트워크 탭에서 WebSocket 메시지 확인
3. 백엔드 로그 확인: `docker-compose logs backend`

## 라이선스

MIT License

## 기여

Pull Request 환영합니다!

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request
