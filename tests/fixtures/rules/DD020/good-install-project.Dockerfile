FROM python:3.12-slim
COPY . /src
RUN pip install /src
