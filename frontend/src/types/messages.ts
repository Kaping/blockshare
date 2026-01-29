/**
 * WebSocket 메시지 타입 정의
 */

// 사용자 정보
export interface User {
  clientId: string;
  nickname: string;
  color: string;
}

// === Client → Server 메시지 ===

export interface LockAcquireMessage {
  t: 'LOCK_ACQUIRE';
  payload: {
    blockId: string;
  };
}

export interface CommitMessage {
  t: 'COMMIT';
  payload: {
    blockId: string;
    events: any[];  // Blockly event JSON
    workspaceXml?: string;
    releaseLock?: boolean;
  };
}

export interface HeartbeatMessage {
  t: 'HEARTBEAT';
  payload: {};
}

export type ClientMessage = LockAcquireMessage | CommitMessage | HeartbeatMessage;

// === Server → Client 메시지 ===

export interface LockDeniedMessage {
  t: 'LOCK_DENIED';
  payload: {
    blockId: string;
    owner: string;
    ttlMs: number;
  };
}

export interface LockUpdateMessage {
  t: 'LOCK_UPDATE';
  payload: {
    blockId: string;
    owner: string | null;
  };
}

export interface CommitApplyMessage {
  t: 'COMMIT_APPLY';
  payload: {
    blockId: string;
    events: any[];
    by: string;
    workspaceXml?: string;
  };
}

export interface UserJoinedMessage {
  t: 'USER_JOINED';
  payload: {
    clientId: string;
    nickname: string;
    color: string;
  };
}

export interface UserLeftMessage {
  t: 'USER_LEFT';
  payload: {
    clientId: string;
  };
}

export interface InitStateMessage {
  t: 'INIT_STATE';
  payload: {
    clientId: string;  // 자신의 clientId
    users: User[];
    locks: Record<string, string>;  // blockId → owner
    workspaceXml?: string;
  };
}

export type ServerMessage =
  | LockDeniedMessage
  | LockUpdateMessage
  | CommitApplyMessage
  | UserJoinedMessage
  | UserLeftMessage
  | InitStateMessage;

// 메시지 타입 상수
export const MessageType = {
  LOCK_ACQUIRE: 'LOCK_ACQUIRE',
  LOCK_DENIED: 'LOCK_DENIED',
  LOCK_UPDATE: 'LOCK_UPDATE',
  COMMIT: 'COMMIT',
  COMMIT_APPLY: 'COMMIT_APPLY',
  USER_JOINED: 'USER_JOINED',
  USER_LEFT: 'USER_LEFT',
  INIT_STATE: 'INIT_STATE',
  HEARTBEAT: 'HEARTBEAT',
} as const;
