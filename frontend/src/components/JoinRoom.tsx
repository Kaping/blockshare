import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import './JoinRoom.css'

interface RoomInfo {
  room_id: string;
  title: string;
  max_users: number;
  current_users: number;
}

function JoinRoom() {
  const [nickname, setNickname] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const { roomId } = useParams<{ roomId: string }>()
  const navigate = useNavigate()

  async function handleJoin() {
    if (!nickname.trim()) {
      setError('닉네임을 입력해주세요')
      return
    }

    setLoading(true)
    setError('')

    try {
      // Room 정보 조회
      const response = await fetch(`http://localhost:8000/api/room/${roomId}/`)
      if (!response.ok) {
        throw new Error('방 정보를 가져올 수 없습니다')
      }

      const room: RoomInfo = await response.json()

      // 인원 체크
      if (room.current_users >= room.max_users) {
        setError('방이 꽉 찼습니다')
        return
      }

      // 워크스페이스로 이동
      navigate(`/workspace/${roomId}`, { state: { nickname: nickname.trim() } })
    } catch (err) {
      setError(err instanceof Error ? err.message : '알 수 없는 오류가 발생했습니다')
    } finally {
      setLoading(false)
    }
  }

  function handleKeyPress(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      handleJoin()
    }
  }

  return (
    <div className="join-room">
      <div className="join-room-card">
        <h1>BlockShare</h1>
        <p className="room-id">Room: {roomId}</p>

        <div className="form-group">
          <label htmlFor="nickname">닉네임</label>
          <input
            id="nickname"
            type="text"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="닉네임을 입력하세요"
            maxLength={20}
            disabled={loading}
            autoFocus
          />
        </div>

        {error && <div className="error-message">{error}</div>}

        <button
          className="join-button"
          onClick={handleJoin}
          disabled={loading || !nickname.trim()}
        >
          {loading ? '입장 중...' : '입장하기'}
        </button>
      </div>
    </div>
  )
}

export default JoinRoom
