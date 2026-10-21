FROM python:3.12-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py trim.py trim_integration.py concat.py ./

RUN mkdir -p /data/tasks
EXPOSE 12000
CMD ["gunicorn", "--bind", "0.0.0.0:12000", "--workers", "1", "--threads", "4", "server:app"]
