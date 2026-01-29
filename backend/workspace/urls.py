from django.urls import path
from . import views

urlpatterns = [
    path('room/<str:room_id>/', views.get_room, name='get_room'),
]
