"use client";
import { Toaster as Sonner } from "sonner"

const Toaster = ({
  ...props
}) => {
  return (
    (<Sonner
      theme="light"
      className="toaster group"
      closeButton
      duration={60000}
      toastOptions={{
        style: {
          maxWidth: "400px",
          padding: "16px",
          fontSize: "13px",
        },
        classNames: {
          toast: "group toast group-[.toaster]:bg-background group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          title: "group-[.toast]:text-[#111827] group-[.toast]:font-bold group-[.toast]:text-[14px]",
          description: "group-[.toast]:text-[#374151] group-[.toast]:text-[13px] group-[.toast]:leading-relaxed",
          closeButton: "group-[.toast]:text-[#9ca3af] hover:group-[.toast]:text-[#374151]",
          actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props} />)
  );
}

export { Toaster }
