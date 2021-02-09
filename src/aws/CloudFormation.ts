import CloudFormation from 'aws-sdk/clients/cloudformation';

export async function getOutputs(region: string, stackName: string): Promise<Record<string, string>> {
    const cloudFormation = new CloudFormation({
        region: region,
    });

    const stack = await cloudFormation.describeStacks({
        StackName: stackName,
    }).promise();

    if (! stack.Stacks || ! stack.Stacks[0].Outputs) {
        throw new Error(`Stack ${stackName} is not deployed yet.`);
    }

    const out: Record<string, string> = {};
    for (const output of stack.Stacks[0].Outputs) {
        if (output.OutputKey && output.OutputValue) {
            out[output.OutputKey] = output.OutputValue;
        }
    }
    return out;
}

export async function getMetadata(region: string, stackName: string): Promise<Record<string, any> | undefined> {
    const cloudFormation = new CloudFormation({
        region: region,
    });

    const templateSummary = await cloudFormation.getTemplateSummary({
        StackName: stackName,
    }).promise();

    if (! templateSummary.Metadata) {
        return undefined;
    }

    return JSON.parse(templateSummary.Metadata);
}
