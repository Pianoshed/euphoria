from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.urls import include, path, re_path
from django.views.static import serve
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView

urlpatterns = [
    path("", include("apps.common.urls")),
    path("admin/", admin.site.urls),
    path("api/accounts/", include("apps.accounts.urls")),
    path("api/services/", include("apps.services.urls")),
    path("api/bookings/", include("apps.bookings.urls")),
    path("api/wallet/", include("apps.wallet.urls")),
    path("api/moderation/", include("apps.moderation.urls")),
    path("api/chat/", include("apps.chat.urls")),
    path("api/schema/", SpectacularAPIView.as_view(), name="schema"),
    path("api/docs/", SpectacularSwaggerView.as_view(url_name="schema"), name="docs"),
]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
else:
    # STAGING/DEMO ONLY. Serves uploaded media (avatars, chat photos) straight
    # from disk. Render's disk is wiped on every deploy/restart, so uploads
    # disappear. Replace with object storage (R2/S3/Cloudinary via
    # django-storages) before real users, then delete this block.
    urlpatterns += [
        re_path(r"^media/(?P<path>.*)$", serve, {"document_root": settings.MEDIA_ROOT}),
    ]