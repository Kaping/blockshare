/**
 * WebSocket 클라이언트
 *
 * 서버와의 WebSocket 연결을 관리하고 메시지 송수신 처리
 */

import { ServerMessage, ClientMessage } from '../types/messages'

type MessageHandler = (message: ServerMessage) => void

export class WebSocketClient {
  private ws: WebSocket | null = null
  private messageHandlers: Map<string, MessageHandler[]> = new Map()
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private reconnectDelay = 1000  // 초기 딜레이 1초
  private reconnectTimer: number | null = null
  private roomId: string = ''
  private nickname: string = ''
  private shouldReconnect = true

  // 연결 상태 콜백
  onConnected?: () => void
  onDisconnected?: () => void
  onReconnecting?: () => void
  onError?: (error: Event) => void

  constructor() {
    // Empty constructor
  }

  /**
   * WebSocket 연결 시작
   */
  connect(roomId: string, nickname: string): Promise<void> {
    this.roomId = roomId
    this.nickname = nickname
    this.shouldReconnect = true

    return new Promise((resolve, reject) => {
      try {
        // WebSocket URL 구성
        const wsUrl = `ws://localhost:8000/ws/workspace/${roomId}/?nickname=${encodeURIComponent(nickname)}`
        console.log('[WS Client] Connecting to:', wsUrl)

        this.ws = new WebSocket(wsUrl)
        console.log('[WS Client] WebSocket object created')

        // 연결 성공
        this.ws.onopen = () => {
          console.log('[WS Client] ✅ WebSocket connected!')
          this.reconnectAttempts = 0
          if (this.onConnected) {
            this.onConnected()
          }
          resolve()
        }

        // 메시지 수신
        this.ws.onmessage = (event) => {
          console.log('[WS Client] 📨 Message received:', event.data)
          this.handleMessage(event.data)
        }

        // 연결 종료
        this.ws.onclose = (event) => {
          console.log('[WS Client] ❌ WebSocket disconnected. Code:', event.code, 'Reason:', event.reason)
          this.ws = null

          if (this.onDisconnected) {
            this.onDisconnected()
          }

          // 자동 재연결
          if (this.shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
            this.scheduleReconnect()
          }
        }

        // 에러 처리
        this.ws.onerror = (error) => {
          console.error('[WS Client] ⚠️ WebSocket error:', error)
          if (this.onError) {
            this.onError(error)
          }
          reject(error)
        }

      } catch (error) {
        console.error('[WS Client] ⚠️ Failed to create WebSocket:', error)
        reject(error)
      }
    })
  }

  /**
   * 재연결 스케줄링 (exponential backoff)
   */
  private scheduleReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
    }

    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts)
    console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts + 1}/${this.maxReconnectAttempts})`)

    if (this.onReconnecting) {
      this.onReconnecting()
    }

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectAttempts++
      this.connect(this.roomId, this.nickname).catch((error) => {
        console.error('Reconnection failed', error)
      })
    }, delay)
  }

  /**
   * 메시지 수신 처리
   */
  private handleMessage(data: string) {
    try {
      const message: ServerMessage = JSON.parse(data)
      console.log('Received message:', message)

      // 메시지 타입별 핸들러 호출
      const handlers = this.messageHandlers.get(message.t) || []
      handlers.forEach(handler => handler(message))

      // 모든 메시지를 받는 핸들러 ('*')
      const allHandlers = this.messageHandlers.get('*') || []
      allHandlers.forEach(handler => handler(message))

    } catch (error) {
      console.error('Failed to parse message:', error)
    }
  }

  /**
   * 메시지 전송
   */
  send(message: ClientMessage) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message))
      console.log('Sent message:', message)
    } else {
      console.warn('WebSocket not connected, cannot send message')
    }
  }

  /**
   * 메시지 핸들러 등록
   */
  on(messageType: string, handler: MessageHandler) {
    if (!this.messageHandlers.has(messageType)) {
      this.messageHandlers.set(messageType, [])
    }
    this.messageHandlers.get(messageType)!.push(handler)
  }

  /**
   * 메시지 핸들러 제거
   */
  off(messageType: string, handler: MessageHandler) {
    const handlers = this.messageHandlers.get(messageType)
    if (handlers) {
      const index = handlers.indexOf(handler)
      if (index > -1) {
        handlers.splice(index, 1)
      }
    }
  }

  /**
   * 연결 종료
   */
  disconnect() {
    this.shouldReconnect = false

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    if (this.ws) {
      this.ws.close()
      this.ws = null
    }

    this.messageHandlers.clear()
  }

  /**
   * 연결 상태 확인
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }
}
