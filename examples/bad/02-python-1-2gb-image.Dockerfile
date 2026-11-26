# The 1.2 GB Python image: full base, compilers kept, package caches kept.
# expect: DD001 DD003 DD007 DD016 DD018 DD024 DD025 DD026 DD028 DD031 DD032 DD034 DD044
FROM python:latest
RUN apt-get update
RUN apt-get install -y build-essential libpq-dev curl
RUN curl -sSL https://install.example.com/setup.sh | bash
COPY requirements.txt /app/requirements.txt
RUN pip install -r /app/requirements.txt
RUN pip install gunicorn flask
COPY . /app
ENV DEBIAN_FRONTEND=noninteractive
CMD gunicorn app:app -b 0.0.0.0:8000
