"""開発用の簡易サーバー（python tools/serve.py [ポート]）。

標準の http.server だと、ブラウザが ES モジュールをキャッシュしてしまい、
ファイルを直しても古いものが読まれ続けることがある。
（「そんな関数は export されていない」という不可解なエラーになる）
確認のたびにキャッシュを疑わずに済むよう、no-store を付けて配る。

公開先の GitHub Pages はこのファイルを使わない。あくまで手元の確認用。
"""

import functools
import http.server
import os
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'docs')


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):
        # 静的ファイルのアクセスログは開発中はノイズなので、エラーだけ出す
        if args and str(args[1]).startswith(('4', '5')):
            super().log_message(fmt, *args)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8031
    handler = functools.partial(NoCacheHandler, directory=os.path.normpath(ROOT))
    with http.server.ThreadingHTTPServer(('127.0.0.1', port), handler) as httpd:
        print('http://localhost:%d/  (Ctrl+C で終了)' % port, flush=True)
        httpd.serve_forever()


if __name__ == '__main__':
    main()
