#!/usr/bin/env python3
"""Receive camera-initiated photo transfers over explicit TLS FTP."""

import logging
from ipaddress import IPv4Address
from pathlib import Path

from OpenSSL import SSL
from pyftpdlib.authorizers import DummyAuthorizer
from pyftpdlib.handlers import TLS_FTPHandler
from pyftpdlib.servers import FTPServer

CONFIG = Path.home() / ".config/pi-field-notes"
PHOTOS = Path.home() / "camera-photos"


class CameraTransfer(TLS_FTPHandler):
    tls_control_required = True
    tls_data_required = True
    passive_ports = range(30000, 30011)
    certfile = str(CONFIG / "transfer.crt")
    keyfile = str(CONFIG / "transfer.key")

    @classmethod
    def get_ssl_context(cls):
        if cls.ssl_context is None:
            context = SSL.Context(SSL.TLS_SERVER_METHOD)
            context.set_min_proto_version(SSL.TLS1_VERSION)
            context.set_cipher_list(b"DEFAULT:@SECLEVEL=0")
            context.use_certificate_chain_file(cls.certfile)
            context.use_privatekey_file(cls.keyfile)
            cls.ssl_context = context
        return cls.ssl_context

    def on_connect(self):
        if self.remote_ip != self.allowed_ip:
            self.close()

    def ftp_STOR(self, file, mode="w"):
        if Path(file).exists():
            self.respond("550 File already exists")
            return None
        return super().ftp_STOR(file, mode)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    authorizer = DummyAuthorizer()
    password = (CONFIG / "transfer-password").read_text().strip()
    CameraTransfer.allowed_ip = str(
        IPv4Address((CONFIG / "transfer-camera-ip").read_text().strip())
    )
    authorizer.add_user("camera", password, str(PHOTOS), perm="elmw")
    CameraTransfer.authorizer = authorizer
    server = FTPServer(("0.0.0.0", 2121), CameraTransfer)
    server.max_cons = 8
    server.max_cons_per_ip = 4
    server.serve_forever()
