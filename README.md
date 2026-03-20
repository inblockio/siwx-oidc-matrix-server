# siwx-oidc-matrix-server

# Table of Contents

1. [Parameters](#parameters)
2. [Examples](#examples)
3. [Issues/integrations](#issuesintegrations)
4. [Mobile Wallet Usage](#mobile-wallet-usage)

## Parameters

### General

#### --ENABLE_DEBUG

This parameter enables Debug mode for detailed logging and troubleshooting. When activated, it ignores the --detach
option in Docker-Compose, keeping the process in the foreground to allow real-time log output. It also sets the log
level of the siwx-oidc service to debug, providing more granular logs for debugging purposes.

#### --LETSENCRYPT_EMAIL **Required**

This parameter specifies the email address associated with the Let's Encrypt certificate. The email address will be used
for important notifications, such as certificate expiry warnings or security updates. It is strongly recommended to
provide a valid and monitored email address to ensure you receive these alerts.

#### --reset

<span style="color:red">BE CAREFULL!!! THIS WILL DELETE ALL YOUR DATA!!!</span> <br>

#### --stop

stop all container

### SIWX-OIDC Config

> **Note:** Environment variable names still use the `SIWEOIDC_` prefix for
> backward compatibility with configuration tooling.

#### --SIWEOIDC_CLIENT_ID

<span style="color:red">ONLY USE IT IF YOU KNOW WHAT YOU DO</span> <br>
(if not set, we will generate one) <br>
This parameter sets the client ID used by the siwx-oidc service for OpenID Connect (OIDC) authentication. The client ID
is a unique identifier issued by the OIDC provider (such as an Identity Provider) and is required for the service to
authenticate and authorize requests properly.

#### --SIWEOIDC_SECRET_ID

<span style="color:red">ONLY USE IT IF YOU KNOW WHAT YOU DO</span> <br>
(if not set, we will generate one) <br>
This parameter defines the client secret associated with the siwx-oidc service for OpenID Connect (OIDC) authentication.
The secret is used alongside the client ID to authenticate the service with the OIDC provider. It ensures secure
communication during the authentication and token exchange process.

#### --SIWEOIDC_HOST **Required**

This parameter specifies the hostname or URL of the siwx-oidc service, which acts as the OpenID Connect (OIDC) provider's
endpoint. The host defines where the service is reachable for authentication requests and token handling.

#### --SIWEOIDC_PORT

<span style="color:red">ONLY USE IT IF YOU KNOW WHAT YOU DO</span> <br>
This parameter specifies the port number on which the siwx-oidc service listens for incoming connections. It defines the
network port used to access the service in conjunction with the SIWEOIDC_HOST.

#### --SIWEOIDC_DEFAULT_CLIENTS

<span style="color:red">ONLY USE IT IF YOU KNOW WHAT YOU DO</span> <br>
This parameter defines a list of default clients that are pre-configured to interact with the siwx-oidc service for
OpenID Connect (OIDC) authentication. Each client in this list typically includes necessary information such as client
IDs, secrets, and redirect URIs, allowing them to authenticate seamlessly with the OIDC provider.

### Matrix

#### --MATRIX_HOST **Required**

This parameter specifies the hostname or URL of the Matrix server instance.

#### --MATRIX_PORT

<span style="color:red">ONLY USE IT IF YOU KNOW WHAT YOU DO</span> <br>
This parameter specifies the port number on which the Matrix server is listening for incoming connections. It works in
conjunction with the MATRIX_HOST to define the complete address for accessing the Matrix server.

#### --MATRIX_MESSAGE_LIFETIME

default: 4w <br>
This parameter sets the duration for which messages are retained on the Matrix server before they are automatically
deleted. The value defines how long a message will be stored, measured in hours or days, ensuring that messages are not
kept indefinitely.

#### --MATRIX_REPORT_STATS

default: false
This parameter enables or disables the reporting of statistical data related to the Matrix server's performance and
usage. When activated, the server will periodically send statistical reports to a specified endpoint or log them for
monitoring and analysis purposes.

## Security

### .env file permissions

The `.env` file contains secrets and must be readable only by its owner:

```
chmod 600 .env
```

## Examples

### startup:

````
./start-matrix.sh --MATRIX_HOST matrix.example.com --SIWEOIDC_HOST siwx-oidc.example.com --LETSENCRYPT_EMAIL max.mustermann@example.com
````

### stop:

````
./start-matrix.sh --stop
````

### reset:

````
./start-matrix.sh --reset
````

## Issues/Integrations
### App-Element-Android:
https://github.com/element-hq/element-meta/discussions/2556

## Mobile Wallet Usage
### What works well with mobile is to use this (https://app.cinny.in/) matrix web-client in combination with [Phatom Wallet](https://phantom.app/) tested on iOS.

