from django.contrib import admin
from .models import Room


@admin.register(Room)
class RoomAdmin(admin.ModelAdmin):
    list_display = ('room_id', 'title', 'max_users', 'created_at')
    search_fields = ('room_id', 'title')
    readonly_fields = ('created_at',)
