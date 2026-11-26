FROM python:3.12-slim
RUN pip install flask==3.0.3 gunicorn==22.0.0
RUN pip install -r requirements.txt
RUN pip install --upgrade pip
