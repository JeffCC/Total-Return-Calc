#!/bin/bash
cd "$(dirname "$0")"
python3 -c "import requests" 2>/dev/null || python3 -m pip install --user requests
python3 -X utf8 server.py
