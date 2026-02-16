import { parseProjectOwnership, type Project, type Settings } from '../store/types'

export function getPreferredGithubLogin(project: Project, settings: Settings): string | undefined {
  const ownership = parseProjectOwnership(project.ownership)
  const preferred = ownership === 'work'
    ? settings.githubWorkLogin.trim()
    : settings.githubPersonalLogin.trim()
  return preferred || undefined
}
