# Minimum version: v1.121.0 (MSC3861 experimental support required)
FROM matrixdotorg/synapse:latest
RUN apt update && apt install wget -y && apt clean
RUN wget https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64 -O /usr/bin/yq && chmod +x /usr/bin/yq
COPY ./entrypoints/matrix_server.sh /matrix_server.sh
ENTRYPOINT ["/matrix_server.sh"]
