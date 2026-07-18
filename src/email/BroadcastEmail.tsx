import {
  Body,
  Container,
  Head,
  Html,
  Preview,
  Section,
  Tailwind,
  Text
} from "@react-email/components";

export interface BroadcastEmailProps {
  previewText: string;
  htmlBody: string;
}

export function BroadcastEmail({ previewText, htmlBody }: BroadcastEmailProps) {
  return (
    <Html lang="en">
      <Tailwind>
        <Head />
        <Preview>{previewText}</Preview>
        <Body className="m-0 bg-white font-sans text-[#232323]">
          <Container className="mx-auto my-0 max-w-[600px] px-[24px] py-[32px]">
            <Section>
              <div dangerouslySetInnerHTML={{ __html: htmlBody }} />
            </Section>
            <Section className="mt-[32px] border-0 border-t border-solid border-[#d8dee4] pt-[16px]">
              <Text className="m-0 text-[12px] leading-[18px] text-[#687078]">
                You are receiving this because you subscribed to this list.
              </Text>
            </Section>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}
