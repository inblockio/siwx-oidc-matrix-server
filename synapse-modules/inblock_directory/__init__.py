# SPDX-License-Identifier: Apache-2.0
#
# Copyright 2026 inblock.io assets GmbH
#
# Synapse module: directory search for admitted service accounts. The contract
# is docs/directory-search.md; the entry Synapse loads is
# `inblock_directory.DirectoryModule`.

from inblock_directory.module import DirectoryConfig, DirectoryModule

__all__ = ["DirectoryConfig", "DirectoryModule"]
