import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import './JoinRoom.css'
import { useI18n } from '../i18n/useI18n'
import LanguageSelector from './LanguageSelector'

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
  const { t } = useI18n()

  async function handleJoin() {
    if (!nickname.trim()) {
      setError(t('error.nicknameRequired'))
      return
    }

    setLoading(true)
    setError('')

    try {
      // Room 정보 조회
      const response = await fetch(`http://localhost:8000/api/room/${roomId}/`)
      if (!response.ok) {
        throw new Error(t('error.roomFetchFailed'))
      }

      const room: RoomInfo = await response.json()

      // 인원 체크
      if (room.current_users >= room.max_users) {
        setError(t('error.roomFull'))
        return
      }

      // 워크스페이스로 이동
      navigate(`/workspace/${roomId}`, { state: { nickname: nickname.trim() } })
    } catch (err) {
      setError(err instanceof Error ? err.message : t('error.unknownError'))
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
        <div className="join-room-header">
          <h1>{t('ui.appTitle')}</h1>
          <LanguageSelector />
        </div>
        <p className="room-id">{t('ui.roomLabel', { roomId: roomId || '' })}</p>

        <div className="form-group">
          <label htmlFor="nickname">{t('ui.nicknameLabel')}</label>
          <input
            id="nickname"
            type="text"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder={t('ui.nicknamePlaceholder')}
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
          {loading ? t('ui.joining') : t('ui.joinButton')}
        </button>
      </div>
    </div>
  )
}

export default JoinRoom
