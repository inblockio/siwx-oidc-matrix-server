#!/bin/bash

ENV_FILE=./.env

SIWEOIDC_HOST=
CLIENT_HOST=
SIWEOIDC_PORT=
RUST_LOG="siwx_oidc=error,tower_http=error"
SIWEOIDC_BASE_URL=
MATRIX_HOST=
MATRIX_PORT=
MATRIX_BASE_URL=
MATRIX_REPORT_STATS=no
MATRIX_MESSAGE_LIFETIME=4w
ATTACH=false

#formatting
bold=$(tput bold)
red=$(tput setaf 1)
reset=$(tput sgr0)

function printHelp() {
echo "#################################################################"
echo "General"
echo "--ENABLE_DEBUG \"enable debug-mode (disable detach and set siwx-oidc debug-level)\""
echo "--reset \"resets/delete all data\""
echo "--stop \"stop all containers\""

echo ""
echo ""

echo "SIWX-OIDC Config"
echo "--SIWEOIDC_HOST (required) \"set siwx-oidc server e.g. siwx-oidc.example.com\""
echo "--SIWEOIDC_PORT \"set siwx-oidc port e.g. 8081 \" !!!ONLY USE IT IF YOU KNOW WHAT YOU DO!!!"

echo ""
echo ""

echo "MATRIX-Config"
echo "--MATRIX_HOST (required) \"set matrix-server e.g. matrix.example.com\""
echo "--MATRIX_PORT \"set matrix-port e.g. 8080 !!!ONLY USE IT IF YOU KNOW WHAT YOU DO!!!\""
echo "--MATRIX_MESSAGE_LIFETIME \"set message lifetime default: 4w"
echo "--MATRIX_REPORT_STATS \"default: no\""

echo ""
echo ""

echo "Element Web Client Config"
echo "--CLIENT_HOST (required) \"set element-web client hostname e.g. element.example.com\""

echo ""
echo ""
echo "#################################################################"
}

function stopContainers() {
    docker compose down
}


function resetAllData() {
    read -r -p $'Destroying containers and deleting all data \n\tAre you sure? [y/N] ' response
    case "$response" in
                    [yY][eE][sS]|[yY])
                        docker compose down -v
                        rm .env
                        ;;
                    *)
                        echo "Aborting..."
                        exit 0
                        ;;
                esac
}

function echoError() {
    text=$1
    echo "${bold}${red}${text}${reset}"
}


function startupServer() {
if [ "$ATTACH" == "true" ]; then
    docker compose up --pull always
else
  docker compose up --pull always -d
fi
}

function appendSigningKey() {
  # Generate a persistent ES256 signing key and append it to .env as a single-line
  # double-quoted value. Docker Compose (godotenv) converts \n to actual newlines
  # when passing to the container, so the app receives a valid PEM string.
  # The key lives only in .env (chmod 600, gitignored) -- no separate file on disk.
  PEM=$(openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 2>/dev/null)
  PEM_LINE=$(printf '%s' "$PEM" | sed ':a;N;$!ba;s/\n/\\n/g')
  echo "SIWEOIDC_SIGNING_KEY_PEM=\"${PEM_LINE}\"" >> .env
  echo "Generated persistent OIDC signing key (stored in .env)"
}

function checkRequiredArguments() {

    if [[ -z "${MATRIX_HOST}" ]]; then
      echoError "missing MATRIX_HOST!!!!"
      echoError "use --MATRIX_HOST"
      printHelp
      exit 1
    fi

    if [[ -z "${SIWEOIDC_HOST}" ]]; then
      echoError "missing SIWEOIDC_HOST!!!!"
      echoError "use --SIWEOIDC_HOST"
      printHelp
      exit 1
    fi

    if [[ -z "${CLIENT_HOST}" ]]; then
      echoError "missing CLIENT_HOST!!!!"
      echoError "use --CLIENT_HOST"
      printHelp
      exit 1
    fi

}

function checkAutoCompletion() {
    if  test -z "$SIWEOIDC_BASE_URL"; then
      SIWEOIDC_BASE_URL="https://${SIWEOIDC_HOST}"
    fi

    if test -z "$MATRIX_BASE_URL"; then
      MATRIX_BASE_URL="https://${MATRIX_HOST}"
    fi
}

function fillMissing() {

  if test -z "$SIWEOIDC_PORT"; then
      SIWEOIDC_PORT=8081
  fi

  if test -z "$MATRIX_PORT"; then
    MATRIX_PORT=8080
  fi

}



while [ "$#" -gt 0 ]; do
        case "$1" in
            --help)
              printHelp
              exit 1
              ;;
            --reset)
              resetAllData
              exit 1
              ;;
            --stop)
              stopContainers
              exit 1
              ;;
            --SIWEOIDC_HOST)
                SIWEOIDC_HOST="$2"
                shift
                shift
                ;;
            --CLIENT_HOST)
                CLIENT_HOST="$2"
                shift
                shift
                ;;
            --SIWEOIDC_PORT)
                SIWEOIDC_PORT="$2"
                shift
                shift
                ;;
            --ENABLE_DEBUG)
                RUST_LOG="siwx_oidc=debug,tower_http=trace"
                ATTACH=true
                shift
                ;;
            --MATRIX_HOST)
                MATRIX_HOST="$2"
                shift
                shift
                ;;
            --MATRIX_PORT)
                MATRIX_PORT="$2"
                shift
                shift
                ;;
            --MATRIX_MESSAGE_LIFETIME)
                MATRIX_MESSAGE_LIFETIME="$2"
                shift
                shift
                ;;
            --MATRIX_REPORT_STATS)
                MATRIX_REPORT_STATS=yes
                shift
                ;;
                *)
                  echo "unknown arg ${1}"
                exit 0
                ;;
        esac
    done

checkRequiredArguments
checkAutoCompletion
fillMissing


if test -f "$ENV_FILE"; then
  source .env
  echo ".env found! skipping setup!"
  echo "if you want a new setup: rm .env && docker volume rm siwx-oidc-matrix-server_matrix_data"
  startupServer

else

  # Generate MAS shared secret for MSC3861 introspection
  MAS_SHARED_SECRET=$(tr -dc A-Za-z0-9 </dev/urandom | head -c 64; echo)

  rm -f .env
  touch .env
  chmod 600 .env

  echo "#SIWEOIDC-CONFIG" >> .env
  echo "SIWEOIDC_HOST=$SIWEOIDC_HOST" >> .env
  echo "SIWEOIDC_PORT=$SIWEOIDC_PORT" >> .env
  echo "SIWEOIDC_BASE_URL=$SIWEOIDC_BASE_URL" >> .env
  echo "RUST_LOG=$RUST_LOG" >> .env
  appendSigningKey

  echo "" >> .env
  echo "#MSC3861-CONFIG" >> .env
  echo "MAS_SHARED_SECRET=$MAS_SHARED_SECRET" >> .env

  echo "" >> .env
  echo "#MATRIX-CONFIG" >> .env
  echo "MATRIX_HOST=$MATRIX_HOST" >> .env
  echo "MATRIX_PORT=$MATRIX_PORT" >> .env
  echo "MATRIX_BASE_URL=$MATRIX_BASE_URL" >> .env
  echo "MATRIX_REPORT_STATS=$MATRIX_REPORT_STATS" >> .env
  echo "MATRIX_MESSAGE_LIFETIME=$MATRIX_MESSAGE_LIFETIME" >> .env

  echo "" >> .env
  echo "#CLIENT-CONFIG" >> .env
  echo "CLIENT_HOST=$CLIENT_HOST" >> .env

  startupServer

fi
