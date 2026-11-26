FROM python:3.12
RUN apt-get update && apt-get install -y build-essential libpq-dev
RUN pip install -r requirements.txt
