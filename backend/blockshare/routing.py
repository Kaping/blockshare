"""
WebSocket URL routing
"""

from django.urls import re_path
from workspace import consumers

websocket_urlpatterns = [
    re_path(r'ws/workspace/(?P<room_id>\w+)/$', consumers.WorkspaceConsumer.as_asgi()),
]
