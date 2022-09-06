import { ACM } from "aws-sdk";
import { getUtils } from "./logger";

const acm = new ACM();
const certStatuses = ["PENDING_VALIDATION", "ISSUED", "INACTIVE"];

interface ACMCert {
    CertificateArn: string;
    DomainName: string;
}

async function listCertificates(): Promise<Array<ACMCert>> {
    try {
        const certificates = await acm
            .listCertificates({
                CertificateStatuses: ["PENDING_VALIDATION", "ISSUED", "INACTIVE"],
            })
            .promise();

        return certificates.CertificateSummaryList as Array<ACMCert>;
    } catch (err) {
        throw Error("Error listing certificates");
    }
}

async function getClosestMatchCertificateAsync(domain: string | string[]): Promise<string> {
    const certificates = await listCertificates();
    const matches = certificates.filter((certificate) => certificate.DomainName === domain);
    for (const certificate of matches) {
        const CertificateArn = certificate.CertificateArn;
        const details = await acm.describeCertificate({ CertificateArn }).promise();

        const currNotAfter = details.Certificate ? (details.Certificate.NotAfter as Date) : Date.now();

        if (Date.now() < currNotAfter) {
            return CertificateArn;
        }
    }

    return "";
}

export default function getClosestMatchCertificate(domain: string | string[]): string {
    const results = {
        arn: "",
    };
    void getClosestMatchCertificateAsync(domain)
        .then((arn: string) => (results.arn = arn))
        .catch((e) => {
            throw e;
        });

    return results.arn;
}
