/**
 * 온라인 사용자 목록 컴포넌트
 */

import { User } from '../types/messages'
import './OnlineUsers.css'

interface OnlineUsersProps {
  users: User[]
  currentNickname: string
}

function OnlineUsers({ users, currentNickname }: OnlineUsersProps) {
  return (
    <div className="online-users">
      <h3>온라인 사용자 ({users.length + 1}명)</h3>

      <div className="users-list">
        {/* 자신 */}
        <div className="user-item me">
          <div className="user-color" style={{ backgroundColor: '#667eea' }}></div>
          <span className="user-nickname">{currentNickname} (나)</span>
        </div>

        {/* 다른 사용자들 */}
        {users.map(user => (
          <div key={user.clientId} className="user-item">
            <div className="user-color" style={{ backgroundColor: user.color }}></div>
            <span className="user-nickname">{user.nickname}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default OnlineUsers
