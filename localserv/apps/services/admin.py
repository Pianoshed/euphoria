from django.contrib import admin

from .models import Review, Service, ServiceCategory


@admin.register(ServiceCategory)
class ServiceCategoryAdmin(admin.ModelAdmin):
    list_display = ["icon", "name", "slug", "is_active"]
    prepopulated_fields = {"slug": ("name",)}
    search_fields = ["name"]


@admin.register(Service)
class ServiceAdmin(admin.ModelAdmin):
    list_display = ["title", "provider", "category", "status", "price", "created_at"]
    list_filter = ["status", "category"]
    search_fields = ["title", "provider__username"]
    readonly_fields = ["id", "created_at", "updated_at"]


@admin.register(Review)
class ReviewAdmin(admin.ModelAdmin):
    list_display = ["service", "reviewer", "rating", "created_at"]
    list_filter = ["rating"]
    search_fields = ["service__title", "reviewer__username"]
    readonly_fields = ["id", "booking", "reviewer", "service", "rating", "comment", "created_at", "updated_at"]

    def has_add_permission(self, request):
        return False
