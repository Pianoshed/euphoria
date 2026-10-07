from django.urls import path

from . import views

app_name = "square"

urlpatterns = [
    path("statuses/", views.StatusListCreateView.as_view(), name="status-list"),
    path("statuses/<uuid:status_id>/react/", views.StatusReactView.as_view(), name="status-react"),
    path("thoughts/", views.ThoughtListCreateView.as_view(), name="thought-list"),
    path("thoughts/<uuid:thought_id>/react/", views.ThoughtReactView.as_view(), name="thought-react"),
    path("trees/", views.FriendTreeListCreateView.as_view(), name="tree-list"),
    path("trees/<uuid:tree_id>/", views.FriendTreeDetailView.as_view(), name="tree-detail"),
    path("trending/", views.TrendingView.as_view(), name="trending"),
]
