/**
 * 클라이언트 락 매니저
 *
 * 블록 편집 락 상태 관리 및 서버와 동기화
 */

import { WebSocketClient } from './websocket'
import { MessageType, LockUpdateMessage, LockDeniedMessage } from '../types/messages'

interface LockRequest {
  blockId: string
  resolve: (success: boolean) => void
  reject: (error: Error) => void
}

export class LockManager {
  private wsClient: WebSocketClient
  private myClientId: string = ''  // 내 clientId
  private myLocks: Set<string> = new Set()  // 내가 소유한 락
  private lockedBlocks: Map<string, string> = new Map()  // blockId → owner clientId
  private pendingRequests: Map<string, LockRequest> = new Map()

  // 콜백
  onLockUpdate?: (blockId: string, owner: string | null) => void
  onLockDenied?: (blockId: string, owner: string, ttlMs: number) => void

  constructor(wsClient: WebSocketClient) {
    this.wsClient = wsClient

    // 메시지 핸들러 등록
    this.wsClient.on(MessageType.LOCK_UPDATE, this.handleLockUpdate.bind(this))
    this.wsClient.on(MessageType.LOCK_DENIED, this.handleLockDenied.bind(this))
  }

  /**
   * 락 획득 요청
   */
  async requestLock(blockId: string): Promise<boolean> {
    // 이미 소유 중인 락이면 즉시 성공
    if (this.myLocks.has(blockId)) {
      return true
    }

    // 다른 사용자가 소유 중이면 즉시 실패
    const currentOwner = this.lockedBlocks.get(blockId)
    if (currentOwner && !this.isMyLock(blockId)) {
      return false
    }

    // 서버에 락 획득 요청
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(blockId, { blockId, resolve, reject })

      // LOCK_ACQUIRE 메시지 전송
      this.wsClient.send({
        t: MessageType.LOCK_ACQUIRE,
        payload: { blockId }
      })

      // 타임아웃 설정 (5초)
      setTimeout(() => {
        if (this.pendingRequests.has(blockId)) {
          this.pendingRequests.delete(blockId)
          reject(new Error('Lock request timeout'))
        }
      }, 5000)
    })
  }

  /**
   * 락 해제 (커밋)
   */
  releaseLock(blockId: string, events: any[], workspaceXml?: string, force: boolean = false) {
    if (!this.myLocks.has(blockId) && !force) {
      console.warn(`Cannot release lock for ${blockId}: not owned`)
      return
    }

    // COMMIT 메시지 전송
    this.wsClient.send({
      t: MessageType.COMMIT,
      payload: {
        blockId,
        events,
        ...(workspaceXml ? { workspaceXml } : {}),
        releaseLock: true,
      }
    })

    // 로컬 상태 업데이트는 LOCK_UPDATE 메시지를 받을 때 처리
  }

  /**
   * 락 없이 커밋 전송 (생성/삭제/필드 변경 등)
   */
  commitWithoutLock(blockId: string, events: any[], workspaceXml?: string) {
    this.wsClient.send({
      t: MessageType.COMMIT,
      payload: {
        blockId,
        events,
        ...(workspaceXml ? { workspaceXml } : {}),
        releaseLock: false,
      }
    })
  }

  /**
   * 블록 락 상태 확인
   */
  isLocked(blockId: string): boolean {
    return this.lockedBlocks.has(blockId)
  }

  /**
   * 내가 소유한 락인지 확인
   */
  isMyLock(blockId: string): boolean {
    return this.myLocks.has(blockId)
  }

  /**
   * 락 소유자 조회
   */
  getLockOwner(blockId: string): string | null {
    return this.lockedBlocks.get(blockId) || null
  }

  /**
   * 내가 소유한 모든 락 목록
   */
  getMyLocks(): string[] {
    return Array.from(this.myLocks)
  }

  /**
   * 모든 락 상태 조회
   */
  getAllLocks(): Map<string, string> {
    return new Map(this.lockedBlocks)
  }

  /**
   * LOCK_UPDATE 메시지 처리
   */
  private handleLockUpdate(message: LockUpdateMessage) {
    const { blockId, owner } = message.payload
    console.log('[LockManager] LOCK_UPDATE:', { blockId, owner, myClientId: this.myClientId })

    // 대기 중인 요청 처리
    const pendingRequest = this.pendingRequests.get(blockId)
    if (pendingRequest) {
      this.pendingRequests.delete(blockId)

      if (owner && owner === this.myClientId) {
        // 락 획득 성공!
        console.log('[LockManager] Lock acquired successfully for', blockId)
        pendingRequest.resolve(true)
      } else if (owner) {
        // 다른 사용자가 락 획득
        pendingRequest.resolve(false)
      }
    }

    // 로컬 상태 업데이트
    if (owner === null) {
      // 락 해제
      this.lockedBlocks.delete(blockId)
      this.myLocks.delete(blockId)
      console.log('[LockManager] Lock released:', blockId)
    } else {
      // 락 획득/변경
      this.lockedBlocks.set(blockId, owner)

      // 자신의 락인지 확인
      if (owner === this.myClientId) {
        this.myLocks.add(blockId)
        console.log('[LockManager] My lock added:', blockId, 'Total myLocks:', this.myLocks.size)
      }
    }

    // 콜백 호출
    if (this.onLockUpdate) {
      this.onLockUpdate(blockId, owner)
    }
  }

  /**
   * LOCK_DENIED 메시지 처리
   */
  private handleLockDenied(message: LockDeniedMessage) {
    const { blockId, owner, ttlMs } = message.payload

    // 대기 중인 요청 실패 처리
    const pendingRequest = this.pendingRequests.get(blockId)
    if (pendingRequest) {
      this.pendingRequests.delete(blockId)
      pendingRequest.resolve(false)
    }

    // 콜백 호출
    if (this.onLockDenied) {
      this.onLockDenied(blockId, owner, ttlMs)
    }
  }

  /**
   * 초기 락 상태 설정 (INIT_STATE 수신 시 호출)
   */
  setInitialLocks(locks: Record<string, string>) {
    this.lockedBlocks.clear()
    Object.entries(locks).forEach(([blockId, owner]) => {
      this.lockedBlocks.set(blockId, owner)
    })
  }

  /**
   * 내 clientId 설정 (INIT_STATE 또는 연결 시 호출)
   */
  setMyClientId(clientId: string) {
    console.log('[LockManager] Setting myClientId:', clientId)
    this.myClientId = clientId

    // myLocks 재계산
    this.myLocks.clear()
    this.lockedBlocks.forEach((owner, blockId) => {
      if (owner === clientId) {
        this.myLocks.add(blockId)
      }
    })
    console.log('[LockManager] myLocks recalculated:', this.myLocks.size)
  }

  /**
   * 정리
   */
  cleanup() {
    this.myLocks.clear()
    this.lockedBlocks.clear()
    this.pendingRequests.clear()
  }
}
