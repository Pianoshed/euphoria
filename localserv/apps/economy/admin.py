from django.contrib import admin

from .models import GiftTransaction, PlatformFeeSetting, PlannerEarning, TransactionOrder


class ReadOnlyAdmin(admin.ModelAdmin):
    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(TransactionOrder)
class TransactionOrderAdmin(ReadOnlyAdmin):
    list_display = ["id", "buyer", "planner", "gross_amount", "platform_fee_amount", "planner_amount", "status", "created_at", "settled_at"]
    list_filter = ["status", "currency"]
    search_fields = ["id", "buyer__username", "planner__username", "idempotency_key"]


@admin.register(PlannerEarning)
class PlannerEarningAdmin(ReadOnlyAdmin):
    list_display = ["planner", "net_amount", "withdrawn_amount", "refunded_amount", "reserved_amount", "status", "created_at", "settled_at"]
    list_filter = ["status"]
    search_fields = ["planner__username", "order__id"]


@admin.register(GiftTransaction)
class GiftTransactionAdmin(ReadOnlyAdmin):
    list_display = ["sender", "recipient", "amount", "status", "created_at"]
    list_filter = ["status"]
    search_fields = ["sender__username", "recipient__username", "idempotency_key"]


@admin.register(PlatformFeeSetting)
class PlatformFeeSettingAdmin(admin.ModelAdmin):
    list_display = ["name", "rate", "category", "is_active", "updated_at"]
    list_filter = ["is_active"]
