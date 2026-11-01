from django.urls import path

from . import views

urlpatterns = [
    path("ollama", views.OllamaCatalogView.as_view(), name="catalog-ollama"),
]
