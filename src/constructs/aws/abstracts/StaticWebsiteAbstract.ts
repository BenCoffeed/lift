import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import type { CfnDistribution, ErrorResponse } from "aws-cdk-lib/aws-cloudfront";
import {
    AllowedMethods,
    CachePolicy,
    Distribution,
    FunctionEventType,
    HttpVersion,
    ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { S3Origin } from "aws-cdk-lib/aws-cloudfront-origins";
import type { BucketProps, CfnBucket } from "aws-cdk-lib/aws-s3";
import { Bucket } from "aws-cdk-lib/aws-s3";
import type { Construct as CdkConstruct } from "constructs";
import type { CfnResource } from "aws-cdk-lib";
import { Duration, RemovalPolicy } from "aws-cdk-lib";
import { CfnOutput } from "aws-cdk-lib";
import type { ConstructCommands } from "@lift/constructs";
import { AwsConstruct } from "@lift/constructs/abstracts";
import type { AwsProvider } from "@lift/providers";
import chalk from "chalk";
import type { FromSchema } from "json-schema-to-ts";
import { flatten } from "lodash";
import { emptyBucket, invalidateCloudFrontCache } from "../../../classes/aws";
import ServerlessError from "../../../utils/error";
import type { Progress } from "../../../utils/logger";
import { getUtils } from "../../../utils/logger";
import { ensureNameMaxLength } from "../../../utils/naming";
import { s3Sync } from "../../../utils/s3-sync";

export const COMMON_STATIC_WEBSITE_DEFINITION = {
    type: "object",
    properties: {
        path: { type: "string" },
        domain: {
            anyOf: [
                { type: "string" },
                {
                    type: "array",
                    items: { type: "string" },
                },
            ],
        },
        certificate: { type: "string" },
        security: {
            type: "object",
            properties: {
                allowIframe: { type: "boolean" },
            },
            additionalProperties: false,
        },
        errorPage: { type: "string" },
        redirectToMainDomain: { type: "boolean" },
    },
    additionalProperties: false,
    required: ["path"],
} as const;

export type CommonStaticWebsiteConfiguration = FromSchema<typeof COMMON_STATIC_WEBSITE_DEFINITION>;

export abstract class StaticWebsiteAbstract extends AwsConstruct {
    public static commands: ConstructCommands = {
        upload: {
            usage: "Upload files directly to S3 without going through a CloudFormation deployment.",
            handler: StaticWebsiteAbstract.prototype.uploadWebsiteCommand,
        },
    };

    protected readonly distribution: Distribution;
    protected readonly bucket: Bucket;
    protected readonly domains: string[] | undefined;
    private readonly bucketNameOutput: CfnOutput;
    private readonly domainOutput: CfnOutput;
    private readonly cnameOutput: CfnOutput;
    private readonly distributionIdOutput: CfnOutput;

    constructor(
        scope: CdkConstruct,
        protected readonly id: string,
        protected readonly configuration: CommonStaticWebsiteConfiguration,
        protected readonly provider: AwsProvider
    ) {
        super(scope, id);

        const bucketProps = this.getBucketProps();

        this.bucket = new Bucket(this, "Bucket", bucketProps);

        // Cast the domains to an array
        // if configuration.domain is an empty array or an empty string, ignore it
        this.domains =
            configuration.domain !== undefined && configuration.domain.length > 0
                ? flatten([configuration.domain])
                : undefined;
        // if configuration.certificate is an empty string, ignore it
        const certificate =
            configuration.certificate !== undefined && configuration.certificate !== ""
                ? acm.Certificate.fromCertificateArn(this, "Certificate", configuration.certificate)
                : undefined;

        if (this.domains !== undefined && certificate === undefined) {
            throw new ServerlessError(
                `Invalid configuration for the static website '${id}': if a domain is configured, then a certificate ARN must be configured in the 'certificate' option.\n` +
                    "See https://github.com/getlift/lift/blob/master/docs/static-website.md#custom-domain",
                "LIFT_INVALID_CONSTRUCT_CONFIGURATION"
            );
        }

        const functionAssociations = [
            {
                function: this.createResponseFunction(),
                eventType: FunctionEventType.VIEWER_RESPONSE,
            },
        ];

        this.distribution = new Distribution(this, "CDN", {
            comment: `${provider.stackName} ${id} website CDN`,
            // Send all page requests to index.html
            defaultRootObject: "index.html",
            defaultBehavior: {
                // Origins are where CloudFront fetches content
                origin: new S3Origin(this.bucket),
                allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
                // Use the "Managed-CachingOptimized" policy
                // See https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-cache-policies.html#managed-cache-policies-list
                cachePolicy: CachePolicy.CACHING_OPTIMIZED,
                viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                functionAssociations: functionAssociations,
            },
            errorResponses: [this.errorResponse()],
            // Enable http2 transfer for better performances
            httpVersion: HttpVersion.HTTP2,
            certificate: certificate,
            domainNames: this.domains,
        });

        // CloudFormation outputs
        this.bucketNameOutput = new CfnOutput(this, "BucketName", {
            description: "Name of the bucket that stores the static website.",
            value: this.bucket.bucketName,
        });
        let websiteDomain: string = this.distribution.distributionDomainName;
        if (this.domains !== undefined) {
            // In case of multiple domains, we take the first one
            websiteDomain = this.domains[0];
        }
        this.domainOutput = new CfnOutput(this, "Domain", {
            description: "Website domain name.",
            value: websiteDomain,
        });
        this.cnameOutput = new CfnOutput(this, "CloudFrontCName", {
            description: "CloudFront CNAME.",
            value: this.distribution.distributionDomainName,
        });
        this.distributionIdOutput = new CfnOutput(this, "DistributionId", {
            description: "ID of the CloudFront distribution.",
            value: this.distribution.distributionId,
        });
    }

    variables(): Record<string, unknown> {
        return {
            cname: this.distribution.distributionDomainName,
        };
    }

    outputs(): Record<string, () => Promise<string | undefined>> {
        return {
            url: () => this.getUrl(),
            cname: () => this.getCName(),
        };
    }

    extend(): Record<string, CfnResource> {
        return {
            distribution: this.distribution.node.defaultChild as CfnDistribution,
            bucket: this.bucket.node.defaultChild as CfnBucket,
        };
    }

    async postDeploy(): Promise<void> {
        await this.uploadWebsite();
    }

    async uploadWebsiteCommand(): Promise<void> {
        getUtils().log(`Deploying the static website '${this.id}'`);

        const fileChangeCount = await this.uploadWebsite();

        const domain = await this.getDomain();
        if (domain !== undefined) {
            getUtils().log();
            getUtils().log.success(`Deployed https://${domain} ${chalk.gray(`(${fileChangeCount} files changed)`)}`);
        }
    }

    private async uploadWebsite(): Promise<number> {
        const bucketName = await this.getBucketName();
        if (bucketName === undefined) {
            throw new ServerlessError(
                `Could not find the bucket in which to deploy the '${this.id}' website: did you forget to run 'serverless deploy' first?`,
                "LIFT_MISSING_STACK_OUTPUT"
            );
        }

        const progress = getUtils().progress;
        let uploadProgress: Progress | undefined;
        if (progress) {
            uploadProgress = progress.create({
                message: `Uploading directory '${this.configuration.path}' to bucket '${bucketName}'`,
            });
            getUtils().log.verbose(`Uploading directory '${this.configuration.path}' to bucket '${bucketName}'`);
        } else {
            getUtils().log(`Uploading directory '${this.configuration.path}' to bucket '${bucketName}'`);
        }
        const { hasChanges, fileChangeCount } = await s3Sync({
            aws: this.provider,
            localPath: this.configuration.path,
            bucketName,
        });
        if (hasChanges) {
            if (uploadProgress) {
                uploadProgress.update(`Clearing CloudFront DNS cache`);
            } else {
                getUtils().log(`Clearing CloudFront DNS cache`);
            }
            await this.clearCDNCache();
        }

        if (uploadProgress) {
            uploadProgress.remove();
        }

        return fileChangeCount;
    }

    private async clearCDNCache(): Promise<void> {
        const distributionId = await this.getDistributionId();
        if (distributionId === undefined) {
            return;
        }
        await invalidateCloudFrontCache(this.provider, distributionId);
    }

    async preRemove(): Promise<void> {
        const bucketName = await this.getBucketName();
        if (bucketName === undefined) {
            // No bucket found => nothing to delete!
            return;
        }

        getUtils().log(
            `Emptying S3 bucket '${bucketName}' for the '${this.id}' static website, else CloudFormation will fail (it cannot delete a non-empty bucket)`
        );
        await emptyBucket(this.provider, bucketName);
    }

    async getUrl(): Promise<string | undefined> {
        const domain = await this.getDomain();
        if (domain === undefined) {
            return undefined;
        }

        return `https://${domain}`;
    }

    async getBucketName(): Promise<string | undefined> {
        return this.provider.getStackOutput(this.bucketNameOutput);
    }

    async getDomain(): Promise<string | undefined> {
        return this.provider.getStackOutput(this.domainOutput);
    }

    async getCName(): Promise<string | undefined> {
        return this.provider.getStackOutput(this.cnameOutput);
    }

    async getDistributionId(): Promise<string | undefined> {
        return this.provider.getStackOutput(this.distributionIdOutput);
    }

    errorPath(): string | undefined {
        if (this.configuration.errorPage !== undefined) {
            let errorPath = this.configuration.errorPage;
            if (errorPath.startsWith("./") || errorPath.startsWith("../")) {
                throw new ServerlessError(
                    `The 'errorPage' option of the '${this.id}' static website cannot start with './' or '../'. ` +
                        `(it cannot be a relative path).`,
                    "LIFT_INVALID_CONSTRUCT_CONFIGURATION"
                );
            }
            if (!errorPath.startsWith("/")) {
                errorPath = `/${errorPath}`;
            }

            return errorPath;
        }
    }

    private errorResponse(): ErrorResponse {
        const errorPath = this.errorPath();

        // Custom error page
        if (errorPath !== undefined) {
            return {
                httpStatus: 404,
                ttl: Duration.seconds(0),
                responseHttpStatus: 404,
                responsePagePath: errorPath,
            };
        }

        /**
         * The default behavior is optimized for SPA: all unknown URLs are served
         * by index.html so that routing can be done client-side.
         */
        return {
            httpStatus: 404,
            ttl: Duration.seconds(0),
            responseHttpStatus: 200,
            responsePagePath: "/index.html",
        };
    }

    private createResponseFunction(): cloudfront.Function {
        const securityHeaders: Record<string, { value: string }> = {
            "x-frame-options": { value: "SAMEORIGIN" },
            "x-content-type-options": { value: "nosniff" },
            "x-xss-protection": { value: "1; mode=block" },
            "strict-transport-security": { value: "max-age=63072000" },
        };
        if (this.configuration.security?.allowIframe === true) {
            delete securityHeaders["x-frame-options"];
        }
        const jsonHeaders = JSON.stringify(securityHeaders, undefined, 4);
        /**
         * CloudFront function that manipulates the HTTP responses to add security headers.
         */
        const code = `function handler(event) {
    var response = event.response;
    response.headers = Object.assign({}, ${jsonHeaders}, response.headers);
    return response;
}`;

        const functionName = ensureNameMaxLength(
            `${this.provider.stackName}-${this.provider.region}-${this.id}-response`,
            64
        );

        return new cloudfront.Function(this, "ResponseFunction", {
            functionName,
            code: cloudfront.FunctionCode.fromInline(code),
        });
    }

    getBucketProps(): BucketProps {
        return {
            // For a static website, the content is code that should be versioned elsewhere
            removalPolicy: RemovalPolicy.DESTROY,
        };
    }
}
