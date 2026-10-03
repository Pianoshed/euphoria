from django.contrib import admin

from .models import Report


@admin.register(Report)
class ReportAdmin(admin.ModelAdmin):
    list_display = ["target_type", "target_id", "reporter", "reason", "status", "created_at"]
    list_filter = ["status", "target_type", "reason"]
    search_fields = ["reporter__username", "detail"]
    readonly_fields = ["id", "reporter", "target_type", "target_id", "reason", "detail", "created_at", "updated_at"]

    def has_add_permission(self, request):
        return False
