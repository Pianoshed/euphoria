from django.contrib import admin

from .models import Booking, BookingEvent


class BookingEventInline(admin.TabularInline):
    model = BookingEvent
    extra = 0
    readonly_fields = ["actor", "from_status", "to_status", "note", "created_at"]
    can_delete = False

    def has_add_permission(self, request, obj=None):
        return False


@admin.register(Booking)
class BookingAdmin(admin.ModelAdmin):
    list_display = ["id", "service", "customer", "provider", "status", "agreed_price", "created_at"]
    list_filter = ["status"]
    search_fields = ["customer__username", "provider__username", "service__title"]
    readonly_fields = [f.name for f in Booking._meta.fields]
    inlines = [BookingEventInline]

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False


@admin.register(BookingEvent)
class BookingEventAdmin(admin.ModelAdmin):
    list_display = ["booking", "actor", "from_status", "to_status", "created_at"]
    readonly_fields = [f.name for f in BookingEvent._meta.fields]

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False
