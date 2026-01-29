from django.db import models
import redis
import os


class Room(models.Model):
    """
    Room 모델: 워크스페이스 메타데이터 저장
    """
    room_id = models.CharField(max_length=50, unique=True, primary_key=True)
    title = models.CharField(max_length=200, default="Untitled Workspace")
    max_users = models.IntegerField(default=10)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f"{self.title} ({self.room_id})"

    def get_current_users(self):
        """
        Redis에서 현재 온라인 사용자 수 조회
        """
        redis_url = os.environ.get('REDIS_URL', 'redis://localhost:6379/0')
        r = redis.from_url(redis_url, decode_responses=True)

        online_key = f"online:{self.room_id}"
        return r.hlen(online_key)

    class Meta:
        db_table = 'rooms'
