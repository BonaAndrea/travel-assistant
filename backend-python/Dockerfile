FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY backend-python/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY backend-python/app ./app
COPY backend-python/scripts ./scripts
COPY backend-python/migrations ./migrations
COPY backend-python/data/vector-index.json ./data/vector-index.json
EXPOSE 4001
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "4001"]
