import { type ElementType, type HTMLAttributes } from "react";
import { useLanding } from "../context";

type Props = HTMLAttributes<HTMLElement> & { zh: string; en: string; as?: ElementType };
export default function Copy({ zh, en, as: Tag = "span", ...props }: Props) {
  const { language } = useLanding();
  return <Tag {...props}>{language === "zh" ? zh : en}</Tag>;
}
