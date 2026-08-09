import 'dotenv/config'
import express, { type NextFunction, type Request, type Response } from 'express'
import helmet from 'helmet'
import cors from 'cors'
import compression from 'compression'
import { config } from './config.js'
import { rateLimit } from './lib/rateLimit.js'
import { authRouter } from './routes/auth.js'
import { projectsRouter } from './routes/projects.js'
import { projectDetailRouter } from './routes/projectDetail.js'
import { pledgesRouter } from './routes/pledges.js'
import { uploadRouter } from './routes/upload.js'
import { challengesRouter, challengeDetailRouter } from './routes/challenges.js'
import { adminRouter } from './routes/admin.js'

const app = express()

// Behind Caddy on the VM — trust the proxy so req.ip is the real client IP.
app.set('trust proxy', 1)
app.disable('x-powered-by')

app.use(helmet())
app.use(
  cors({
    origin: (origin, callback) => {
      // Same-origin tools (curl, server-to-server) send no Origin header.
      if (!origin || config.allowedOrigins.has(origin)) return callback(null, true)
      return callback(null, false)
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Password'],
    maxAge: 86400,
  })
)
app.use(compression())

// Global per-IP rate limit on top of the per-endpoint limits in the routes.
app.use((req, res, next) => {
  const key = `ip:${req.ip ?? 'unknown'}:${req.method}:${req.path}`
  if (!rateLimit(key, config.rateLimit.max, config.rateLimit.windowMs)) {
    return res.status(429).json({ error: 'too many requests, slow down' })
  }
  next()
})

app.use(express.json({ limit: '1mb' }))

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

app.use('/api/auth', authRouter)
app.use('/api/projects/:id', projectDetailRouter)
app.use('/api/projects', projectsRouter)
app.use('/api/pledges', pledgesRouter)
app.use('/api/upload', uploadRouter)
app.use('/api/challenges/:id', challengeDetailRouter)
app.use('/api/challenges', challengesRouter)
app.use('/api/admin', adminRouter)

app.use((_req, res) => {
  res.status(404).json({ error: 'not found' })
})

// Central error handler — Express 5 forwards rejected async handlers here.
app.use((err: Error & { type?: string; status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid json' })
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'payload too large' })
  }
  console.error('Unhandled error:', err)
  res.status(500).json({ error: 'internal server error' })
})

app.listen(config.port, () => {
  console.log(`[anielab-api] listening on :${config.port} (${config.env})`)
})
