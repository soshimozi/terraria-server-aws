require('dotenv').config()
const crypto = require('crypto')
import * as path from 'path'

import * as apigateway from 'aws-cdk-lib/aws-apigateway'
import * as cdk from 'aws-cdk-lib'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs'
import { Duration } from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'

const App = 'Terraria'

// We create this under a class just to link together resources with 'this'
export class TerrariaServerStack extends cdk.Stack {
  constructor(scope: any, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

    // UserData start-up commands for EC2 Instance
    const userData = new ec2.MultipartUserData()
    const commandsUserData = ec2.UserData.forLinux()
    userData.addUserDataPart(commandsUserData, ec2.MultipartBody.SHELL_SCRIPT, true)

    const dockerCommands = [
      'sudo yum update -y',
      'sudo amazon-linux-extras install docker',
      'sudo service docker start',
      'sudo usermod -a -G docker ec2-user',
    ]

    const terrariaCommands = [
      'mkdir -p $HOME/terraria/world',
      'sudo docker run -it -p 7777:7777 --rm -v $HOME/terraria/world:/root/.local/share/Terraria/Worlds ryshe/terraria:latest -world /root/.local/share/Terraria/Worlds/world1.wld -autocreate 3 --log-opt max-size=200m',
    ]

    userData.addCommands(...dockerCommands)
    userData.addCommands(...terrariaCommands)

    // EC2 Instance
    const vpc = new ec2.Vpc(this, `${App}VPC`, {
      enableDnsHostnames: true,
      enableDnsSupport: true,
    })

    const securityGroup = new ec2.SecurityGroup(this, `${App}SecurityGroup`, {
      vpc,
      description: `Access to server ports for ec2 instance`
    })
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(7777), `Allow ${App} server connections`)
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(7777), `Allow ${App} server connections`)
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'allow ssh access from the world')

    new ec2.Instance(this, `${App}Server`, {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE3, ec2.InstanceSize.SMALL),
      keyName: 'ec2-key-pair',
      machineImage: ec2.MachineImage.latestAmazonLinux(),
      securityGroup,
      userData,
      userDataCausesReplacement: true,
    })

    // Lambdas
    const lambdaDir = path.join(__dirname, 'lambdas')

    const startLambda = new lambda.NodejsFunction(this, `Start${App}ServerLambda`, {
      entry: path.join(lambdaDir, 'start-lambda.ts'),
      handler: 'handler',
      functionName: `Start${App}ServerLambda`,
    })
    startLambda.role?.attachInlinePolicy(new iam.Policy(this, `Start${App}Ec2Policy`, {
      document: new iam.PolicyDocument({
        statements: [new iam.PolicyStatement({
          actions: ['ec2:StartInstances'],
          resources: ['*'],
        })],
      }),
    }))

    const stopLambda = new lambda.NodejsFunction(this, `Stop${App}ServerLambda`, {
      entry: path.join(lambdaDir, 'stop-lambda.ts'),
      handler: 'handler',
      functionName: `Stop${App}ServerLambda`,
    })
    stopLambda.role?.attachInlinePolicy(new iam.Policy(this, `Stop${App}Ec2Policy`, {
      document: new iam.PolicyDocument({
        statements: [new iam.PolicyStatement({
          actions: ['ec2:StopInstances'],
          resources: ['*'],
        })],
      }),
    }))

    const statusLambda = new lambda.NodejsFunction(this, `${App}ServerStatusLambda`, {
      entry: path.join(lambdaDir, 'status-lambda.ts'),
      handler: 'handler',
      functionName: `${App}ServerStatusLambda`,
    })
    statusLambda.role?.attachInlinePolicy(new iam.Policy(this, `${App}Ec2StatusPolicy`, {
      document: new iam.PolicyDocument({
        statements: [new iam.PolicyStatement({
          actions: ['ec2:DescribeInstanceStatus'],
          resources: ['*'],
        })],
      }),
    }))

    const authLambda = new lambda.NodejsFunction(this, `${App}ServerAuthLambda`, {
      entry: path.join(lambdaDir, 'auth-lambda.ts'),
      handler: 'handler',
      functionName: `${App}ServerAuthLambda`,
      environment: {
        'PASSWORD': process.env.PASSWORD ?? crypto.randomUUID()
      },
    })

    // API Gateway
    const api = new apigateway.RestApi(this, `${App}ServerApi`, {
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Authorization'],
      }
    })
    const authorizer = new apigateway.RequestAuthorizer(this, `${App}ServerAuthorizer`, {
      handler: authLambda,
      identitySources: [apigateway.IdentitySource.header('Authorization')],
      resultsCacheTtl: Duration.seconds(0),
    })

    api.root
      .addResource('start')
      .addMethod('POST', new apigateway.LambdaIntegration(startLambda), { authorizer })

    api.root
      .addResource('stop')
      .addMethod('POST', new apigateway.LambdaIntegration(stopLambda), { authorizer })

    api.root
      .addResource('status')
      .addMethod('GET', new apigateway.LambdaIntegration(statusLambda))
  }
}
