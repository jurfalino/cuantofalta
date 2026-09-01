import { Hono } from 'hono'
import { html } from 'hono/html'
import { db, getGoalById, listContributions } from '../db/queries'
import { computeProgress } from '../goals/progress'
import { GoalPage } from './views'
import type { Env } from '../env'

export const publicRoutes = new Hono<{ Bindings: Env }>()

publicRoutes.get('/g/:id', async (c) => {
  const d = db(c.env.DB)
  const goal = await getGoalById(d, c.req.param('id'))
  if (!goal) return c.notFound()
  const progress = computeProgress(goal, await listContributions(d, goal.id))
  return c.html(html`<!DOCTYPE html>${<GoalPage goal={goal} progress={progress} />}`)
})
