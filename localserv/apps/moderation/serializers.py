from rest_framework import serializers

from .models import Report, ReportReason, ReportStatus, ReportTargetType


class ReportCreateSerializer(serializers.Serializer):
    target_type = serializers.ChoiceField(choices=[t.value for t in ReportTargetType])
    target_id = serializers.UUIDField()
    reason = serializers.ChoiceField(choices=[r.value for r in ReportReason])
    detail = serializers.CharField(max_length=1000, allow_blank=True, required=False)


class ReporterSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    username = serializers.CharField()


class ReportSerializer(serializers.ModelSerializer):
    reporter = ReporterSerializer(read_only=True)
    resolved_by_username = serializers.CharField(source="resolved_by.username", read_only=True, default=None)

    class Meta:
        model = Report
        fields = [
            "id", "reporter", "target_type", "target_id", "reason", "detail",
            "status", "resolved_by_username", "resolved_at", "resolution_note", "created_at",
        ]
        read_only_fields = fields


class ReportListQuerySerializer(serializers.Serializer):
    status = serializers.ChoiceField(choices=[s.value for s in ReportStatus], required=False)
    target_type = serializers.ChoiceField(choices=[t.value for t in ReportTargetType], required=False)
    ordering = serializers.CharField(required=False, allow_blank=True)
    page_size = serializers.IntegerField(required=False, min_value=1, max_value=100)


class ReportResolveSerializer(serializers.Serializer):
    resolution = serializers.ChoiceField(choices=[ReportStatus.RESOLVED.value, ReportStatus.DISMISSED.value])
    note = serializers.CharField(max_length=1000, allow_blank=True, required=False)


class ModerationReasonSerializer(serializers.Serializer):
    reason = serializers.CharField(max_length=500)
