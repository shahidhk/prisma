import { Output, Client, Config } from 'prisma-cli-engine'
import * as inquirer from 'inquirer'
import chalk from 'chalk'
import { Cluster, Environment, getEndpoint } from 'prisma-yml'
import { concatName } from '../util'
import * as sillyname from 'sillyname'
import * as path from 'path'
import * as fs from 'fs'

export interface GetEndpointParams {
  folderName: string
}

export type DatabaseType = 'postgres' | 'mysql'

export interface DatabaseCredentials {
  type: DatabaseType
  host: string
  port: number
  user: string
  password: string
  database?: string
  alreadyData?: boolean
}

export interface GetEndpointResult {
  endpoint: string
  cluster: Cluster | undefined
  workspace: string | undefined
  service: string
  stage: string
  localClusterRunning: boolean
}

export class EndpointDialog {
  out: Output
  client: Client
  env: Environment
  config: Config
  constructor(out: Output, client: Client, env: Environment, config: Config) {
    this.out = out
    this.client = client
    this.env = env
    this.config = config
  }

  async getEndpoint(): Promise<GetEndpointResult> {
    const localClusterRunning = await this.isClusterOnline(
      'http://localhost:4466',
    )
    const folderName = path.basename(this.config.definitionDir)
    const loggedIn = await this.client.isAuthenticated()
    const clusters = this.getCloudClusters()
    const files = this.listFiles()
    const hasDockerComposeYml = files.includes('docker-compose.yml')
    const question = this.getClusterQuestion(
      !loggedIn && !localClusterRunning,
      hasDockerComposeYml,
      clusters,
    )

    let clusterEndpoint
    let cluster: Cluster | undefined
    let workspace: string | undefined
    let service = 'default'
    let stage = 'default'
    const { choice } = await this.out.prompt(question)

    switch (choice) {
      case 'Use other server':
        clusterEndpoint = await this.customEndpointSelector(folderName)
        cluster = new Cluster(
          this.out,
          'custom',
          clusterEndpoint,
          process.env.PRISMA_MANAGEMENT_SECRET,
        )
        break
      case 'local':
      case 'Create new database':
        cluster =
          this.env.clusters.find(c => c.name === 'local') ||
          new Cluster(
            this.out,
            'local',
            'http://localhost:4466',
            process.env.PRISMA_MANAGEMENT_SECRET,
          )
        break
      case 'Use existing database':
        const credentials = await this.getDatabase()
        cluster = new Cluster(
          this.out,
          'custom',
          'http://localhost:4466',
          process.env.PRISMA_MANAGEMENT_SECRET,
        )
        break
      case 'sandbox-eu1':
        cluster = this.env.clusters.find(c => c.name === 'prisma-eu1')
      case 'sandbox-us1':
        cluster = this.env.clusters.find(c => c.name === 'prisma-us1')
      default:
        const result = this.getClusterAndWorkspaceFromChoice(choice)
        if (!result.workspace) {
          cluster = clusters.find(c => c.name === result.cluster)
          if (!loggedIn && cluster && cluster.shared) {
            workspace = this.getPublicName()
          }
        } else {
          cluster = clusters.find(
            c =>
              c.name === result.cluster && c.workspaceSlug === result.workspace,
          )
          workspace = result.workspace
        }
    }

    if (!cluster) {
      throw new Error(`Oops. Could not get cluster.`)
    }

    this.env.setActiveCluster(cluster!)

    // TODO propose alternatives if folderName already taken to ensure global uniqueness
    if (
      !cluster.local ||
      (await this.projectExists(cluster, service, stage, workspace))
    ) {
      service = await this.askForService(folderName)
    }

    if (
      !cluster.local ||
      (await this.projectExists(cluster, service, stage, workspace))
    ) {
      stage = await this.askForStage('dev')
    }

    return {
      endpoint: getEndpoint(cluster, service, stage, workspace),
      cluster,
      workspace,
      service,
      stage,
      localClusterRunning,
    }
  }

  private getClusterAndWorkspaceFromChoice(
    choice: string,
  ): { workspace: string | null; cluster: string } {
    const splitted = choice.split('/')
    const workspace = splitted.length > 1 ? splitted[0] : null
    const cluster = splitted.slice(-1)[0]

    return { workspace, cluster }
  }

  private getCloudClusters(): Cluster[] {
    return this.env.clusters.filter(c => c.shared || c.isPrivate)
  }

  private async projectExists(
    cluster: Cluster,
    name: string,
    stage: string,
    workspace: string | undefined,
  ): Promise<boolean> {
    try {
      return Boolean(
        await this.client.getProject(
          concatName(cluster, name, workspace || null),
          stage,
        ),
      )
    } catch (e) {
      return false
    }
  }

  private listFiles() {
    return fs.readdirSync(this.config.definitionDir)
  }

  private async isClusterOnline(endpoint: string): Promise<boolean> {
    const cluster = new Cluster(this.out, 'local', endpoint, undefined, true)
    return cluster.isOnline()
  }

  private getClusterQuestion(
    fromScratch: boolean,
    hasDockerComposeYml: boolean,
    clusters: Cluster[],
  ) {
    const sandboxChoices = [
      [
        'sandbox-eu1',
        'Free development server on Prisma Cloud (incl. database)',
      ],
      [
        'sandbox-us1',
        'Free development server on Prisma Cloud (incl. database)',
      ],
    ]
    if (fromScratch && !hasDockerComposeYml) {
      const rawChoices = [
        ['Use existing database', 'Connect to existing database'],
        ['Create new database', 'Set up a local database using Docker'],
        ...sandboxChoices,
      ]
      const choices = this.convertChoices(rawChoices)
      return {
        name: 'choice',
        type: 'list',
        message: `Connect to your database, set up a new one or use hosted sandbox?`,
        choices: [
          new inquirer.Separator(
            chalk.bold(
              'You can set up Prisma  for local development (requires Docker)',
            ),
          ),
          ...choices.slice(0, 2),
          new inquirer.Separator('                       '),
          new inquirer.Separator(
            chalk.bold(
              'Or use a free hosted Prisma sandbox (includes database)',
            ),
          ),
          ...choices.slice(2, 4),
        ],
        pageSize: 9,
      }
    } else {
      const clusterChoices =
        clusters.length > 0
          ? clusters.map(c => [
              `${c.workspaceSlug || ''}/${c.name}`,
              `Production Prisma cluster`,
            ])
          : sandboxChoices
      const rawChoices = [
        ['local', 'Local Prisma server (connected to MySQL)'],
        ...clusterChoices,
        ['Use other server', 'Connect to an existing prisma server'],
        ['Use existing database', 'Connect to existing database'],
        ['Create new database', 'Set up a local database using Docker'],
      ]
      const choices = this.convertChoices(rawChoices)
      const dockerChoices = hasDockerComposeYml
        ? []
        : [
            new inquirer.Separator(
              chalk.bold(
                'Set up a new Prisma server for local development (requires Docker):',
              ),
            ),
            ...choices.slice(4, 6),
          ]
      return {
        name: 'choice',
        type: 'list',
        message: `Connect to your database, set up a new one or use existing Prisma server?`,
        choices: [
          new inquirer.Separator(chalk.bold('Use an existing Prisma server')),
          ...choices.slice(0, 4),
          new inquirer.Separator('                       '),
          ...dockerChoices,
        ],
        // pageSize: 9,
      }
    }
  }

  private async askForDatabaseType() {
    const { result } = await this.out.prompt({
      name: 'result',
      type: 'list',
      message: `What kinf of database do you want to deploy to?`,
      choices: [
        {
          name: 'mysql',
          value: 'MySQL      MySQL-compliat databases like MySQL, MariaDB',
        },
        {
          name: 'postgres',
          value: 'MySQL      MySQL-compliat databases like MySQL, MariaDB',
        },
      ],
      // pageSize: 9,
    })

    return result
  }

  private convertChoices(
    choices: string[][],
  ): Array<{ value: string; name: string }> {
    const padded = this.out.printPadded(choices, 0, 6).split('\n')
    return padded.map((name, index) => ({
      name,
      value: choices[index][0],
    }))
  }

  private async askForStage(defaultName: string): Promise<string> {
    const question = {
      name: 'stage',
      type: 'input',
      message: 'To which stage do you want to deploy?',
      default: defaultName,
    }

    const { stage } = await this.out.prompt(question)

    // this.showedLines += 1

    return stage
  }

  private async askForService(defaultName: string): Promise<string> {
    const question = {
      name: 'service',
      type: 'input',
      message: 'How do you want to call your service?',
      default: defaultName,
    }

    const { service } = await this.out.prompt(question)

    this.out.up(1)

    return service
  }

  private async customEndpointSelector(defaultName: string): Promise<string> {
    const question = {
      name: 'endpoint',
      type: 'input',
      message: `What's your clusters endpoint?`,
      default: defaultName,
    }

    const { endpoint } = await this.out.prompt(question)

    // this.showedLines += 1

    return endpoint
  }

  private async getDatabase(): Promise<DatabaseCredentials> {
    const type = await this.askForDatabaseType()
    const host = await this.ask('Enter database host')
    const port = await this.ask('Enter database port')
    const user = await this.ask('Enter database user')
    const password = await this.ask('Enter database password')
    const database = await this.ask(
      'Enter database name (only needed when you already have data)',
    )
    const alreadyData = await this.ask(
      'Do you already have data in the database? (yes/no)',
    )

    return { type, host, port, user, password, database, alreadyData }
  }

  private async ask(message: string, defaultValue?: string) {
    const question = {
      name: 'result',
      type: 'input',
      message,
      default: defaultValue,
    }

    const { result } = await this.out.prompt(question)

    return result
  }

  private getSillyName() {
    return `${slugify(sillyname()).split('-')[0]}-${Math.round(
      Math.random() * 1000,
    )}`
  }

  private getPublicName() {
    return `public-${this.getSillyName()}`
  }
}

function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .replace(/\s+/g, '-') // Replace spaces with -
    .replace(/[^\w\-]+/g, '') // Remove all non-word chars
    .replace(/\-\-+/g, '-') // Replace multiple - with single -
    .replace(/^-+/, '') // Trim - from start of text
    .replace(/-+$/, '') // Trim - from end of text
}
