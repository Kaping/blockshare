"""
메시지 직렬화 및 검증
"""
import json
from typing import Dict, Any, Optional


def serialize_message(msg_type: str, payload: Dict[str, Any]) -> str:
    """메시지를 JSON 문자열로 직렬화"""
    return json.dumps({
        't': msg_type,
        'payload': payload
    })


def deserialize_message(text_data: str) -> Optional[Dict[str, Any]]:
    """JSON 문자열을 메시지로 역직렬화"""
    try:
        data = json.loads(text_data)
        if 't' not in data or 'payload' not in data:
            return None
        return data
    except json.JSONDecodeError:
        return None


# 메시지 타입 상수
class MessageType:
    LOCK_ACQUIRE = "LOCK_ACQUIRE"
    LOCK_DENIED = "LOCK_DENIED"
    LOCK_UPDATE = "LOCK_UPDATE"
    COMMIT = "COMMIT"
    COMMIT_APPLY = "COMMIT_APPLY"
    USER_JOINED = "USER_JOINED"
    USER_LEFT = "USER_LEFT"
    INIT_STATE = "INIT_STATE"
    HEARTBEAT = "HEARTBEAT"
