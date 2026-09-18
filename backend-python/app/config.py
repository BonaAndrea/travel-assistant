from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "Travel Assistant Python API"
    environment: str = "development"
    api_prefix: str = "/api"
    database_url: str | None = None
    jwt_secret: str = "development-only-change-me"
    preference_image_dir: str = "uploads/preferences"

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


@lru_cache
def get_settings() -> Settings:
    return Settings()
