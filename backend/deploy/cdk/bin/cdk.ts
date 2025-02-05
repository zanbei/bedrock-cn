#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecs from 'aws-cdk-lib/aws-ecs';
// import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3Deploy from 'aws-cdk-lib/aws-s3-deployment'; 
import * as logs from 'aws-cdk-lib/aws-logs'; 
import * as ec2 from 'aws-cdk-lib/aws-ec2'; 
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { StackProps } from 'aws-cdk-lib'; 
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
// import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
// import * as path from 'path';
import { RemovalPolicy } from 'aws-cdk-lib';
// import * as ecrdeploy from 'cdk-ecr-deployment';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';

// 运行前export以下环境变量
// export GLOBAL_AWS_SECRET_ACCESS_KEY='your_secret_access_key'
// export GLOBAL_AWS_ACCESS_KEY_ID='your_access_key_id'
// export DEEPSEEK_KEY='your_deepseek_key'

const app = new cdk.App(); 

export class LitellmStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'MyVpc', {
      maxAzs: 2, // Maximum Availability Zones
    });

    const securityGroup = new ec2.SecurityGroup(this, 'MySecurityGroup', {
      vpc,
      allowAllOutbound: true,
      securityGroupName: 'MySecurityGroup'
    });
    
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'Allow HTTP traffic');
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(4000), 'Allow HTTPS traffic');
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(3306), 'Allow HTTPS traffic');
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(8000), 'Allow HTTPS traffic');

    // 创建公共 EC2 实例

    // 使用 SSM 参数获取最新的 Ubuntu AMI
    const machineImage = ec2.MachineImage.fromSsmParameter(
      '/aws/service/canonical/ubuntu/server/focal/stable/current/amd64/hvm/ebs-gp2/ami-id',
      {os: ec2.OperatingSystemType.LINUX,}
    );

    const instance = new ec2.Instance(this, 'bastion', {
      instanceType: new ec2.InstanceType('t3.medium'), // 实例类型
      machineImage: machineImage,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC }, // 使用公共子网
      securityGroup,
      keyName: 'nx2007' // 指定密钥对名称（不需要 .pem 后缀）
    });

    // const suffix = Math.random().toString(36).substring(2, 6);
    const suffix = 'ikvn'

    // china region 的 cdk-ecr-deployment 无法使用，原因是lambda无法下载public ecr

    // const ecrRepo = new ecr.Repository(this, 'MyECR', {
    //   repositoryName: `litellm-${suffix}`,
    //   removalPolicy: RemovalPolicy.DESTROY, // 设置删除策略为 DESTROY
    //   emptyOnDelete: true, // 可选：强制删除仓库时删除所有内容
    // });

    const ecrRepo = ecr.Repository.fromRepositoryName(this, 'MyECR', 'litellm');

    // const dockerImage = new ecr_assets.DockerImageAsset(this, 'litellm', {
    //   directory: path.join(__dirname, '../../docker'),
    // });

    // new ecrdeploy.ECRDeployment(this, 'DeployDockerImage', {
    //   src: new ecrdeploy.DockerImageName(dockerImage.imageUri),
    //   dest: new ecrdeploy.DockerImageName(`${ecrRepo.repositoryUri}:latest`), // 使用指定的仓库 URI 和标签
    // });


    const configBucket = new s3.Bucket(this, 'ConfigBucket', {
      bucketName: `bedrock-china-${suffix}`,
      removalPolicy: RemovalPolicy.DESTROY, // 设置删除策略为 DESTROY
      autoDeleteObjects: true, // 可选：强制删除仓库时删除所有内容<end_of_file>
    });

    new s3Deploy.BucketDeployment(this, 'ConfigFile', {
      sources: [s3Deploy.Source.asset('../config')],
      destinationBucket: configBucket,
    });

    // const rdsCluster = new rds.ServerlessCluster(this, `litellm-${suffix}`, {
    //   engine: rds.DatabaseClusterEngine.auroraPostgres({
    //     version: rds.AuroraPostgresEngineVersion.VER_15_2 }),
    //   vpc: vpc,
    //   scaling: {
    //     autoPause: cdk.Duration.minutes(10), // Auto pause after 10 minutes of inactivity
    //     minCapacity: rds.AuroraCapacityUnit.ACU_1, // Minimum capacity
    //     maxCapacity: rds.AuroraCapacityUnit.ACU_4, // Maximum capacity
    //   },
    //   credentials: rds.Credentials.fromPassword('anbei', cdk.SecretValue.plainText('Qwer1234')),
    //   defaultDatabaseName: 'litellm',  // Optional: specify a database name
    // });

    const ecsTaskExecutionRole = new iam.Role(this, 'EcsTaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    // 创建 ECR 权限策略
    const ecrPolicy = new iam.Policy(this, 'EcrPolicy', {
      statements: [
        new iam.PolicyStatement({
          actions: [
            'ecr:GetAuthorizationToken',
            'ecr:BatchCheckLayerAvailability',
            'ecr:GetDownloadUrlForLayer',
            'ecr:BatchGetImage',
          ],
          resources: ['*'], // 或者指定特定的 ECR ARN
        }),
      ],
    });
    ecrPolicy.attachToRole(ecsTaskExecutionRole);

    ecsTaskExecutionRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'));
    ecsTaskExecutionRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3ReadOnlyAccess'));

    const ecsCluster = new ecs.Cluster(this, 'LitellmCluster', {
      clusterName: `litellm_${suffix}`,
      vpc: vpc,
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'LitellmTask', {
      taskRole: ecsTaskExecutionRole,
      executionRole: ecsTaskExecutionRole,
      cpu: 2048, // Increase to 2048 (2 vCPUs)
      memoryLimitMiB: 4096, // Increase to 4096 (4 GB)
    });

    taskDefinition.addContainer('LitellmContainer', {
      image: ecs.ContainerImage.fromEcrRepository(ecrRepo),
      memoryLimitMiB: 2048,
      cpu: 1024,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'ecs',
        logGroup: new logs.LogGroup(this, '/ecs/litellm'),
      }),
      environment: {
        GLOBAL_AWS_REGION: 'us-west-2',
        GLOBAL_AWS_SECRET_ACCESS_KEY: process.env.GLOBAL_AWS_SECRET_ACCESS_KEY || '',
        GLOBAL_AWS_ACCESS_KEY_ID: process.env.GLOBAL_AWS_ACCESS_KEY_ID || '',
        LITELLM_CONFIG_BUCKET_OBJECT_KEY: 'litellm_config.yaml',
        AWS_DEFAULT_REGION: 'cn-northwest-1',
        LITELLM_CONFIG_BUCKET_NAME: configBucket.bucketName,
        LITELLM_LOG: 'DEBUG',
        DEEPSEEK_KEY: process.env.DEEPSEEK_KEY || '',
        DATA_BASE_URL: '',
      },
      portMappings: [{ containerPort: 4000 }],
    });

    

    // 创建 Cloud Map 命名空间
    const namespace = new servicediscovery.PrivateDnsNamespace(this, 'MyNamespace', {
      name: 'litellm.local',
      vpc,
    });

    const LitellmService = new ecs.FargateService(this, 'LitellmService', {
      cluster: ecsCluster,
      taskDefinition,
      desiredCount: 1,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC},
      securityGroups: [securityGroup], 
      cloudMapOptions: {
        cloudMapNamespace: namespace,
        name: 'litellm', // 服务名称
      },
    });

    // 返回记录名称
    const recordName = `${LitellmService.serviceName}.${namespace.namespaceName}`;

    const ecrRepoProxy = ecr.Repository.fromRepositoryName(this, 'proxyrepo', 'proxy');

    const taskDefinitionProxy = new ecs.FargateTaskDefinition(this, 'ProxyTask', {
      taskRole: ecsTaskExecutionRole,
      executionRole: ecsTaskExecutionRole,
      cpu: 2048, // Increase to 2048 (2 vCPUs)
      memoryLimitMiB: 4096, // Increase to 4096 (4 GB)
    });

    taskDefinitionProxy.addContainer('ProxyContainer', {
      image: ecs.ContainerImage.fromEcrRepository(ecrRepoProxy),
      memoryLimitMiB: 2048,
      cpu: 1024,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'ecs',
        logGroup: new logs.LogGroup(this, '/ecs/proxy'),
      }),
      environment: {
        AWS_REGION_NAME: 'us-west-2',
        OPENAI_API_URL: "http://${recordName}:4000/v1/chat/completions", // service discovery
        AWS_SECRET_ACCESS_KEY: process.env.GLOBAL_AWS_SECRET_ACCESS_KEY || '',
        AWS_ACCESS_KEY_ID: process.env.GLOBAL_AWS_ACCESS_KEY_ID || '',
      },
      portMappings: [{ containerPort: 4000 }],
    });

    const ProxyService = new ecs.FargateService(this, 'ProxyService', {
      cluster: ecsCluster,
      taskDefinition: taskDefinitionProxy,
      desiredCount: 1,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [securityGroup], 
      cloudMapOptions: {
        cloudMapNamespace: namespace,
        name: 'proxy', // 服务名称
      },
    });


    const region = this.region;
    const regionMapping = new cdk.CfnMapping(this, 'regionMapping', {
      mapping: {
        'cn-north-1': {
          lwaLayerArn: 'arn:aws-cn:lambda:cn-north-1:041581134020:layer:LambdaAdapterLayerX86:24',
        },
        'cn-northwest-1': {
          lwaLayerArn: 'arn:aws-cn:lambda:cn-northwest-1:069767869989:layer:LambdaAdapterLayerX86:24',
        },
      }
    });
    const frontendFn = new lambda.Function(this, "frontend", {
      runtime: lambda.Runtime.PROVIDED_AL2,
      handler: "bootstrap",
      memorySize: 2048,
      code: lambda.Code.fromAsset("../../../frontend", {
        bundling: {
          image: lambda.Runtime.NODEJS_22_X.bundlingImage,
          command: [
            "bash",
            "-c",
            [
              "npm install",
              "npm run build",
              "cp -au ./out/* /asset-output",
              "cp misc/bootstrap /asset-output",
              "cp misc/nginx.conf /asset-output",
              "chmod +x /asset-output/bootstrap",
            ].join(" && "),
          ],
          user: "root",
        },
      }),
      environment: {
        PORT: "8080",
      },
      layers: [
        lambda.LayerVersion.fromLayerVersionArn(
          this,
          "LWALayer",
          regionMapping.findInMap(this.region, 'lwaLayerArn', `arn:aws:lambda:${this.region}:753240598075:layer:LambdaAdapterLayerX86:24`)
        ),
        new lambda.LayerVersion(this, "NginxLayer", {
          code: lambda.Code.fromAsset("../../../frontend/misc/Nginx123X86.zip"),
        }),
      ],
    });
    const http = new apigw.HttpApi(this, "PortalApi");
    http.addRoutes({
      path: "/{proxy+}",
      methods: [apigw.HttpMethod.GET],
      integration: new HttpLambdaIntegration(
        "frontendFnIntegration",
        frontendFn
      ),
    });
    new cdk.CfnOutput(this, "Web Portal URL", {
      value: http.url!,
      description: "Web portal url",
    });
  }
}

new LitellmStack(app, 'BackLlm', {
});
