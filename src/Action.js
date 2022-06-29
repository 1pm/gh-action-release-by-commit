import * as core from '@actions/core'
import { context } from '@actions/github'
import { MD5 as md5 } from 'object-hash'
import GitHub from './GitHub.js'

const semverTpl = '(?<version>(?<prefix>v?)(?<semver>(?<major>0|[1-9]\\d*)\\.(?<minor>0|[1-9]\\d*)\\.(?<patch>0|[1-9]\\d*)(?:-(?<prerelease>(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\\+(?<build>[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?))'
const semver = new RegExp(`(?<=^|[^a-zA-Z0-9.+-])${semverTpl}(?=[^a-zA-Z0-9.+-]|$)`)

const prereleaseTpl = '(?:^|\\s)(?:(v))?(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-((?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*))*))(?:\\+([0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?'
const prerelease = new RegExp(`${prereleaseTpl}`)

const isTrue = val => {
  const trueStrings = ['(true)', 'true', '1', 'yes', 'y']

  for (const str of trueStrings) {
    if (val.match(new RegExp(`^${str}$`, 'i'))) {
      return true
    }
  }

  return false
}

const cache = {}
const compile = source => {
  const id = md5(source)

  if (! cache[id]) {
    cache[id] = data => {
      const names = Object.keys(data)
      const vals = Object.values(data)

      return new Function(...names, `return \`${source}\``)(...vals)
    }
  }

  return cache[id]
}

const template = source => {
  return source.replace(/\$(0|[1-9]\d*)/, '${$$$1}')
    .replace(/\$(?!\d)(\w+)/g, '${$1}')
}

const bindCompiler = matches => {
  return source => {
    const tpl = template(source)
    const render = compile(tpl)
    const data = {
      ...Object.fromEntries(matches.map((v, k) => ['$' + k, v])),
      ...matches.groups,
    }

    Object.keys(data).forEach(key => {
      if (data[key] === undefined) {
        data[key] = ''
      }
    })

    return render(data)
  }
}

class Action {
  constructor() {
    const regex = core.getInput('regex')
    let regexArgs = {}
    const prereleaseRegex = core.getInput('prerelease-regex')
    let prereleaseRegexArgs = {}
    let token

    if (regex) {
      const matches = regex.match(/^\/(.*?)\/([gimy]*)$/)

      if (matches === null) {
        throw 'The regex input was not a valid regex string'
      }

      const [, pattern, flags] = matches

      regexArgs.pattern = pattern.replace(/#{\s*semver\s*}/i, semverTpl)
      regexArgs.flags = flags
    }

    if (prereleaseRegex) {
      const matches = prereleaseRegex.match(/^\/(.*?)\/([gimy]*)$/)

      if (matches === null) {
        throw 'The prerelease-regex input was not a valid regex string'
      }

      const [,pattern, flags] = matches

      prereleaseRegexArgs.pattern = pattern.replace(/#{\s*semver\s*}/i, prereleaseTpl)
      prereleaseRegexArgs.flags = flags
    }

    if (! (token = process.env.GITHUB_TOKEN)) {
      throw 'The GITHUB_TOKEN environment variable was not set'
    }

    this.gh = new GitHub(token)

    this.config = {
      regex: regexArgs.pattern ? new RegExp(regexArgs.pattern, regexArgs.flags) : semver,
      prereleaseRegex: prereleaseRegexArgs.pattern ? new RegExp(prereleaseRegexArgs.pattern, prereleaseRegexArgs.flags) : prerelease,
      title: core.getInput('title') || 'Version $semver',
      tag: core.getInput('tag') || '$version',
      draft: isTrue(core.getInput('draft')),
      version: '$version',
    }
  }

  async run() {
    const commits = context.payload.commits

    if (commits.length === 0) {
      core.info('No commits found')
      core.setOutput('released', false)

      return
    }

    let releaseCommit
    let matches

    for (const commit of commits) {
      if ((matches = commit.message.match(this.config.regex))) {
        releaseCommit = commit

        break
      }
    }

    if (! releaseCommit) {
      core.info('No commit message found matching release regex')
      core.setOutput('released', false)

      return
    }

    const render = bindCompiler(matches)
    const version = render(this.config.version)
    const ref = releaseCommit.id
    const prerelease = releaseCommit.message.match(this.config.prereleaseRegex) !== null

    core.info(`THIS.GH -+> ${Object.keys(this.gh).join(', ')}`)

    const response = await this.gh.repos.createRelease({
      ...context.repo,
      name: render(this.config.title),
      tag_name: render(this.config.tag),
      generate_release_notes: true,
      draft: this.config.draft,
      prerelease,
      target_commitish: ref,
    })

    const {
      data: { id: releaseId, html_url: htmlUrl, upload_url: uploadUrl },
    } = response

    core.info(`id: ${releaseId}`)
    core.info(`version: ${version}`)
    core.info(`html_url: ${htmlUrl}`)
    core.info(`upload_url: ${uploadUrl}`)
    core.info(`released: true`)

    core.setOutput('id', releaseId)
    core.setOutput('version', version)
    core.setOutput('html_url', htmlUrl)
    core.setOutput('upload_url', uploadUrl)
    core.setOutput('released', true)
  }
}

export default Action
