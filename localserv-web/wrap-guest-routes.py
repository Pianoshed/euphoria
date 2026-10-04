"""Wrap /login, /login/2fa and /register in <GuestRoute> inside src/App.jsx (idempotent).
Run from the web project root:  python3 wrap-guest-routes.py"""
import re, sys
p = 'src/App.jsx'
s = open(p).read()
if 'GuestRoute' in s:
    print('App.jsx already uses GuestRoute: nothing to do'); sys.exit(0)

import_line = "import { GuestRoute } from './components/GuestRoute';\n"
m = re.search(r"^import .*ProtectedRoute.*\n", s, re.M) or list(re.finditer(r"^import .*\n", s, re.M))[-1]
s = s[:m.end()] + import_line + s[m.end():]

count = 0
for path, comp in (('/register', 'Register'), ('/login', 'Login'), ('/login/2fa', 'LoginTwoFactor')):
    pat = re.compile(r'(<Route\s+path="%s"\s+element=\{)<%s\s*/>(\}\s*/>)' % (re.escape(path), comp))
    s, n = pat.subn(r'\1<GuestRoute><%s /></GuestRoute>\2' % comp, s)
    count += n
    if not n:
        print(f'WARNING: could not find the {path} route to wrap; wrap it by hand:  element={{<GuestRoute><{comp} /></GuestRoute>}}')
open(p, 'w').write(s)
print(f'wrapped {count} of 3 routes in GuestRoute')
