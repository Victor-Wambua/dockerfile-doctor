FROM python:3.12-slim
RUN pip install --trusted-host pypi.example.com requests==2.32.3
