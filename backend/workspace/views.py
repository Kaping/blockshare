from django.http import JsonResponse
from django.views.decorators.http import require_http_methods
from .models import Room


@require_http_methods(["GET"])
def get_room(request, room_id):
    """
    Room 정보 조회 API
    Room이 존재하지 않으면 자동 생성
    """
    room, created = Room.objects.get_or_create(
        room_id=room_id,
        defaults={
            'title': f'Room {room_id}',
            'max_users': 10
        }
    )

    current_users = room.get_current_users()

    return JsonResponse({
        'room_id': room.room_id,
        'title': room.title,
        'max_users': room.max_users,
        'current_users': current_users,
        'created': created,
    })
