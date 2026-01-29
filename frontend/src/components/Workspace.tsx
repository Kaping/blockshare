import { useState, useEffect, useMemo, useRef } from 'react'
import { useParams, useLocation, useNavigate } from 'react-router-dom'
import { WebSocketClient } from '../services/websocket'
import { LockManager } from '../services/lockManager'
import BlocklyEditor from './BlocklyEditor'
import OnlineUsers from './OnlineUsers'
import './Workspace.css'
import { MessageType, User } from '../types/messages'

function Workspace() {
  const { roomId } = useParams<{ roomId: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const nickname = location.state?.nickname

  const [connected, setConnected] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const [onlineUsers, setOnlineUsers] = useState<User[]>([])
  const [myClientId, setMyClientId] = useState<string | null>(null)

  const wsClientRef = useRef<WebSocketClient | null>(null)
  const lockManagerRef = useRef<LockManager | null>(null)
  const heartbeatTimerRef = useRef<number | null>(null)
  const myClientIdRef = useRef<string | null>(null)

  useEffect(() => {
    // 닉네임이 없으면 입장 페이지로 리다이렉트
    if (!nickname) {
      navigate(`/room/${roomId}`)
      return
    }

    // WebSocket 클라이언트 생성
    const wsClient = new WebSocketClient()
    wsClientRef.current = wsClient

    // LockManager 생성
    const lockManager = new LockManager(wsClient)
    lockManagerRef.current = lockManager

    const stopHeartbeat = () => {
      if (heartbeatTimerRef.current) {
        clearInterval(heartbeatTimerRef.current)
        heartbeatTimerRef.current = null
      }
    }

    const startHeartbeat = () => {
      stopHeartbeat()
      heartbeatTimerRef.current = window.setInterval(() => {
        if (wsClient.isConnected()) {
          wsClient.send({ t: MessageType.HEARTBEAT, payload: {} })
        }
      }, 10000)
    }

    // 연결 상태 콜백
    wsClient.onConnected = () => {
      console.log('Connected to workspace')
      setConnected(true)
      setReconnecting(false)
      startHeartbeat()
    }

    wsClient.onDisconnected = () => {
      console.log('Disconnected from workspace')
      setConnected(false)
      stopHeartbeat()
    }

    wsClient.onReconnecting = () => {
      console.log('Reconnecting...')
      setReconnecting(true)
    }

    wsClient.onError = (error) => {
      console.error('WebSocket error:', error)
    }

    // 메시지 핸들러 등록
    wsClient.on(MessageType.INIT_STATE, (message: any) => {
      const { clientId, users, locks, workspaceXml } = message.payload
      console.log('[Workspace] INIT_STATE received:', { clientId, users, locks })

      // 내 clientId 설정 (중요!)
      lockManager.setMyClientId(clientId)
      myClientIdRef.current = clientId
      setMyClientId(clientId)

      // 온라인 사용자 목록 설정
      setOnlineUsers(users)

      // 락 상태 초기화
      lockManager.setInitialLocks(locks)

      // 워크스페이스 스냅샷 적용
      if (workspaceXml) {
        if ((window as any).__loadWorkspaceSnapshot) {
          (window as any).__loadWorkspaceSnapshot(workspaceXml)
        } else {
          (window as any).__pendingWorkspaceSnapshot = workspaceXml
        }
      }
    })

    wsClient.on(MessageType.USER_JOINED, (message: any) => {
      const user = message.payload
      console.log('USER_JOINED:', user)

      setOnlineUsers(prev => [...prev, {
        clientId: user.clientId,
        nickname: user.nickname,
        color: user.color,
      }])
    })

    wsClient.on(MessageType.USER_LEFT, (message: any) => {
      const { clientId } = message.payload
      console.log('USER_LEFT:', clientId)

      setOnlineUsers(prev => prev.filter(u => u.clientId !== clientId))
    })

    wsClient.on(MessageType.COMMIT_APPLY, (message: any) => {
      const { blockId, events, by, workspaceXml } = message.payload
      console.log('[Workspace] COMMIT_APPLY received:', { blockId, by, events })

      // 내 커밋은 로컬에 이미 반영되어 있으므로 스킵
      if (myClientIdRef.current && by === myClientIdRef.current) {
        return
      }

      // Blockly 에디터에 원격 변경 적용
      if ((window as any).__applyRemoteChange) {
        console.log('[Workspace] Calling applyRemoteChange')
        try {
          (window as any).__applyRemoteChange(events)
        } catch (error) {
          console.error('[Workspace] Error applying remote change:', error)
        }
      } else {
        console.warn('[Workspace] applyRemoteChange not available')
      }

      // 이벤트 적용 실패 대비 스냅샷 적용
      if (workspaceXml) {
        if ((window as any).__loadWorkspaceSnapshot) {
          (window as any).__loadWorkspaceSnapshot(workspaceXml)
        } else {
          (window as any).__pendingWorkspaceSnapshot = workspaceXml
        }
      }
    })

    // WebSocket 연결
    wsClient.connect(roomId!, nickname).catch((error) => {
      console.error('Failed to connect:', error)
      alert('서버 연결에 실패했습니다')
      navigate(`/room/${roomId}`)
    })

    // Cleanup
    return () => {
      stopHeartbeat()
      wsClient.disconnect()
      lockManager.cleanup()
    }
  }, [roomId, nickname, navigate])

  const userMap = useMemo(() => {
    const map: Record<string, { nickname: string; color: string }> = {}
    if (myClientId && nickname) {
      map[myClientId] = { nickname, color: '#667eea' }
    }
    onlineUsers.forEach(user => {
      map[user.clientId] = { nickname: user.nickname, color: user.color }
    })
    return map
  }, [onlineUsers, myClientId, nickname])

  if (!nickname) {
    return null
  }

  return (
    <div className="workspace">
      <div className="workspace-header">
        <div className="header-left">
          <h2>Room: {roomId}</h2>
          <span className="nickname">Welcome, {nickname}!</span>
        </div>

        <div className="header-right">
          {reconnecting && (
            <span className="status reconnecting">재연결 중...</span>
          )}
          {!connected && !reconnecting && (
            <span className="status disconnected">연결 끊김</span>
          )}
          {connected && (
            <span className="status connected">연결됨</span>
          )}
        </div>
      </div>

      <div className="workspace-main">
        <div className="editor-container">
          {connected && lockManagerRef.current && (
            <BlocklyEditor
              lockManager={lockManagerRef.current}
              userMap={userMap}
              myClientId={myClientId}
            />
          )}
          {!connected && (
            <div className="loading">서버에 연결 중...</div>
          )}
        </div>

        <OnlineUsers users={onlineUsers} currentNickname={nickname} />
      </div>
    </div>
  )
}

export default Workspace
